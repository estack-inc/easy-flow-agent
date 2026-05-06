import { Readable } from "node:stream";
import * as tar from "tar";
import { EasyflowError } from "../utils/errors.js";

export interface ExtractedFile {
  content: Buffer;
  mode: number;
}

export interface ExtractedLayer {
  files: Map<string, ExtractedFile>;
}

/**
 * tar.gz バッファからファイルを展開する。
 * パストラバーサル（`..` または絶対パス）は拒否する。
 */
export async function extractLayer(tarGz: Buffer): Promise<ExtractedLayer> {
  const files = new Map<string, ExtractedFile>();
  const chunks = new Map<string, Buffer[]>();

  await new Promise<void>((resolve, reject) => {
    const readable = Readable.from(tarGz);
    const parser = new tar.Parser();

    parser.on("entry", (entry: tar.ReadEntry) => {
      const filePath = entry.path;

      // 絶対パスを拒否
      if (filePath.startsWith("/")) {
        entry.resume();
        reject(
          new EasyflowError(
            `不正なパス: "${filePath}"`,
            "絶対パスはレイヤー内で許可されていません",
          ),
        );
        return;
      }

      // パストラバーサルを拒否
      const segments = filePath.split("/");
      for (const seg of segments) {
        if (seg === "..") {
          entry.resume();
          reject(
            new EasyflowError(
              `不正なパス: "${filePath}"`,
              "パストラバーサル (..) はレイヤー内で許可されていません",
            ),
          );
          return;
        }
      }

      if (entry.type !== "File") {
        entry.resume();
        return;
      }

      const bufList: Buffer[] = [];
      const fileMode = entry.mode ?? 0o644;
      chunks.set(filePath, bufList);

      entry.on("data", (chunk: Buffer) => {
        bufList.push(chunk);
      });
      entry.on("end", () => {
        files.set(filePath, { content: Buffer.concat(bufList), mode: fileMode });
      });
      entry.on("error", reject);
    });

    parser.on("end", resolve);
    parser.on("error", reject);

    readable.pipe(parser);
  });

  return { files };
}
