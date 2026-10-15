import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, rename, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type { Metadata } from "sharp";
import {
  CoffeeValidationError,
  type BrewPhoto,
  type BrewPhotoWithPaths,
  type UpdateBrewPhotoInput,
} from "./domain.js";
import { CoffeeRepository } from "./repository.js";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_MANAGED_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_PIXELS = 80_000_000;
const require = createRequire(import.meta.url);
let sharpModule: Promise<typeof import("sharp")> | undefined;

function loadSharp(): Promise<typeof import("sharp")> {
  if (!sharpModule) {
    if (process.platform === "linux") {
      const packageNames = [
        `@img/sharp-libvips-linux-${process.arch}`,
        `@img/sharp-libvips-linuxmusl-${process.arch}`,
      ];
      for (const packageName of packageNames) {
        try {
          const packagePath = require.resolve(`${packageName}/package.json`);
          const libraryPath = join(dirname(packagePath), "lib");
          process.env.LD_LIBRARY_PATH = [libraryPath, process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":");
          break;
        } catch {
          // Try the next libc/platform package name.
        }
      }
    }
    sharpModule = import("sharp");
  }
  return sharpModule;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function imageFormat(format: string | undefined): {
  extension: "jpg" | "png" | "webp";
  mimeType: BrewPhoto["mime_type"];
} {
  if (format === "jpeg") return { extension: "jpg", mimeType: "image/jpeg" };
  if (format === "png") return { extension: "png", mimeType: "image/png" };
  if (format === "webp") return { extension: "webp", mimeType: "image/webp" };
  throw new CoffeeValidationError("photo must be a JPEG, PNG, or WebP image");
}

export class BrewPhotoService {
  readonly photosRoot: string;

  constructor(
    private readonly repository: CoffeeRepository,
    databasePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.photosRoot = join(dirname(databasePath), "photos");
  }

  async add(input: {
    brew_id: number;
    source_path: string;
    caption?: string;
    captured_at?: string;
  }): Promise<BrewPhotoWithPaths> {
    const sourcePath = resolve(input.source_path);
    const source = await lstat(sourcePath).catch(() => undefined);
    if (!source?.isFile() || source.isSymbolicLink()) {
      throw new CoffeeValidationError("source_path must be an existing regular image file, not a symlink");
    }
    if (source.size < 1 || source.size > MAX_SOURCE_BYTES) {
      throw new CoffeeValidationError("photo must be between 1 byte and 25 MB");
    }

    const { default: sharp } = await loadSharp();
    let metadata: Metadata;
    try {
      metadata = await sharp(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch {
      throw new CoffeeValidationError("source_path is not a readable supported image");
    }
    const format = imageFormat(metadata.format);
    const now = this.now();
    const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const id = randomUUID();
    const relativePath = `${folder}/${id}.${format.extension}`;
    const thumbnailRelativePath = `${folder}/${id}-thumb.webp`;
    const filePath = join(this.photosRoot, relativePath);
    const thumbnailFilePath = join(this.photosRoot, thumbnailRelativePath);
    const temporaryFilePath = `${filePath}.tmp`;
    const temporaryThumbnailPath = `${thumbnailFilePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      const image = sharp(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
      if (format.extension === "jpg") await image.jpeg({ quality: 95, mozjpeg: true }).toFile(temporaryFilePath);
      else if (format.extension === "png") await image.png({ compressionLevel: 9 }).toFile(temporaryFilePath);
      else await image.webp({ quality: 95 }).toFile(temporaryFilePath);

      await sharp(temporaryFilePath, { limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(temporaryThumbnailPath);
      await chmod(temporaryFilePath, 0o600);
      await chmod(temporaryThumbnailPath, 0o600);
      await rename(temporaryFilePath, filePath);
      await rename(temporaryThumbnailPath, thumbnailFilePath);

      const [managedMetadata, managedStat, digest] = await Promise.all([
        sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(),
        stat(filePath),
        sha256(filePath),
      ]);
      if (!managedMetadata.width || !managedMetadata.height) {
        throw new CoffeeValidationError("processed image has no dimensions");
      }
      if (managedStat.size > MAX_MANAGED_BYTES) {
        throw new CoffeeValidationError("processed image exceeds the 50 MB managed-file limit");
      }
      const photo = this.repository.addBrewPhoto({
        brew_id: input.brew_id,
        relative_path: relativePath,
        thumbnail_relative_path: thumbnailRelativePath,
        original_filename: basename(sourcePath),
        mime_type: format.mimeType,
        byte_size: managedStat.size,
        sha256: digest,
        width: managedMetadata.width,
        height: managedMetadata.height,
        caption: input.caption,
        captured_at: input.captured_at,
      });
      return this.withPaths(photo);
    } catch (error) {
      await Promise.all([
        removeIfPresent(temporaryFilePath),
        removeIfPresent(temporaryThumbnailPath),
        removeIfPresent(filePath),
        removeIfPresent(thumbnailFilePath),
      ]);
      if (error instanceof CoffeeValidationError) throw error;
      throw new CoffeeValidationError(`could not store photo: ${(error as Error).message}`);
    }
  }

  list(options: { brew_id?: number; before_id?: number; limit?: number } = {}): BrewPhotoWithPaths[] {
    return this.repository.listBrewPhotos(options).map((photo) => this.withPaths(photo));
  }

  update(photoId: number, input: UpdateBrewPhotoInput): BrewPhotoWithPaths {
    return this.withPaths(this.repository.updateBrewPhoto(photoId, input));
  }

  async delete(photoId: number): Promise<{ deleted: true; photo_id: number; brew_id: number }> {
    const photo = this.repository.getBrewPhoto(photoId);
    const filePath = join(this.photosRoot, photo.relative_path);
    const thumbnailPath = join(this.photosRoot, photo.thumbnail_relative_path);
    const token = randomUUID();
    const stagedFilePath = `${filePath}.deleting-${token}`;
    const stagedThumbnailPath = `${thumbnailPath}.deleting-${token}`;
    try {
      await rename(filePath, stagedFilePath);
      await rename(thumbnailPath, stagedThumbnailPath);
    } catch (error) {
      if (await stat(stagedFilePath).catch(() => undefined)) await rename(stagedFilePath, filePath);
      throw new CoffeeValidationError(`could not stage photo deletion: ${(error as Error).message}`);
    }
    try {
      this.repository.deleteBrewPhoto(photoId);
    } catch (error) {
      await rename(stagedFilePath, filePath);
      await rename(stagedThumbnailPath, thumbnailPath);
      throw error;
    }
    await Promise.all([removeIfPresent(stagedFilePath), removeIfPresent(stagedThumbnailPath)]);
    return { deleted: true, photo_id: photo.id, brew_id: photo.brew_id };
  }

  private withPaths(photo: BrewPhoto): BrewPhotoWithPaths {
    return {
      ...photo,
      file_path: join(this.photosRoot, photo.relative_path),
      thumbnail_file_path: join(this.photosRoot, photo.thumbnail_relative_path),
    };
  }
}
