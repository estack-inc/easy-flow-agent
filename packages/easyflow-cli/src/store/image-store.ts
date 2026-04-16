import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageData, ImageMetadata, StoredImage } from "./types.js";

export class ImageStore {
  private storeDir: string;

  constructor(storeDir?: string) {
    this.storeDir =
      storeDir ?? process.env.EASYFLOW_STORE_DIR ?? path.join(os.homedir(), ".easyflow", "images");
  }

  async save(ref: string, data: ImageData): Promise<StoredImage> {
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
      await fs.writeFile(path.join(layersDir, name), buffer);
    }

    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(this.storeDir, org, name, tag);
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
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(this.storeDir, org, name, tag);

    try {
      const realDir = await fs.realpath(tagDir);
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
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(this.storeDir, org, name, tag);

    try {
      const realDir = await fs.realpath(tagDir);
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
      await this.collectRefsRecursive(this.storeDir, [], result);
    } catch {
      // store directory doesn't exist yet
    }

    return result;
  }

  /**
   * org/name/ ディレクトリを再帰走査し、タグ symlink を起点に StoredImage を構築する。
   * digest ディレクトリ（sha256-*）はスキップして ref 側のみを列挙する。
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
      } else if (entry.isDirectory() && !entry.name.startsWith("sha256-")) {
        await this.collectRefsRecursive(fullPath, [...pathSegments, entry.name], result);
      }
    }
  }

  private buildRef(pathSegments: string[], tag: string): string {
    const nameWithOrg = pathSegments.join("/");
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
      return { org: "_", name: parts[0], tag };
    }
    return { org: parts[0], name: parts.slice(1).join("/"), tag };
  }

  static computeDigest(data: Buffer): string {
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    return `sha256:${hash}`;
  }

  private serializeImageData(data: ImageData): Buffer {
    const parts: Buffer[] = [];
    parts.push(Buffer.from(JSON.stringify(data.manifest)));
    parts.push(Buffer.from(JSON.stringify(data.config)));
    for (const [key, value] of data.layers) {
      parts.push(Buffer.from(key));
      parts.push(value);
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
      return await this.findSymlinksRecursive(this.storeDir, targetDir);
    } catch {
      return false;
    }
  }

  private async findSymlinksRecursive(dir: string, targetDir: string): Promise<boolean> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = await fs.realpath(fullPath);
          if (resolved === targetDir) return true;
        } catch {
          // broken symlink
        }
      } else if (entry.isDirectory() && !entry.name.startsWith("sha256-")) {
        const found = await this.findSymlinksRecursive(fullPath, targetDir);
        if (found) return true;
      }
    }
    return false;
  }
}
