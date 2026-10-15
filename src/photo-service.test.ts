import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrewPhotoService } from "./photo-service.js";
import { CoffeeRepository } from "./repository.js";

describe("BrewPhotoService", () => {
  let directory: string;
  let databasePath: string;
  let sourcePath: string;
  let repository: CoffeeRepository;
  let service: BrewPhotoService;
  let brewId: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "coffee-photo-"));
    databasePath = join(directory, "coffee.sqlite");
    sourcePath = join(directory, "uploaded-latte.jpg");
    repository = new CoffeeRepository(databasePath, "America/Chicago");
    service = new BrewPhotoService(repository, databasePath, () => new Date("2026-10-14T12:00:00.000Z"));
    const bag = repository.addBean({ roaster: "Onyx", name: "Geometry" });
    brewId = repository.logBrew({
      bag_id: bag.id,
      drink_type: "latte",
      timestamp: "2026-10-14T08:30:00-05:00",
    }).id;
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 120, g: 70, b: 40 } },
    }).withMetadata({ orientation: 6 }).jpeg().toFile(sourcePath);
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("stores a sanitized managed image and thumbnail linked to a brew", async () => {
    const photo = await service.add({
      brew_id: brewId,
      source_path: sourcePath,
      caption: "First decent tulip",
    });

    expect(photo).toMatchObject({
      brew_id: brewId,
      original_filename: "uploaded-latte.jpg",
      mime_type: "image/jpeg",
      width: 20,
      height: 40,
      caption: "First decent tulip",
      captured_at: "2026-10-14T13:30:00.000Z",
    });
    expect(photo.relative_path).toMatch(/^2026\/10\/[0-9a-f-]+\.jpg$/);
    expect(photo.thumbnail_relative_path).toMatch(/-thumb\.webp$/);
    expect(existsSync(photo.file_path)).toBe(true);
    expect(existsSync(photo.thumbnail_file_path)).toBe(true);
    expect(photo.sha256).toMatch(/^[a-f0-9]{64}$/);

    const metadata = await sharp(photo.file_path).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect((await sharp(photo.thumbnail_file_path).metadata()).format).toBe("webp");
  });

  it("lists, updates, and permanently deletes photo files and metadata", async () => {
    const photo = await service.add({ brew_id: brewId, source_path: sourcePath });
    expect(service.list({ brew_id: brewId })).toHaveLength(1);
    expect(service.update(photo.id, {
      caption: "Rosetta attempt",
      captured_at: "2026-10-14T09:00:00-05:00",
    })).toMatchObject({
      caption: "Rosetta attempt",
      captured_at: "2026-10-14T14:00:00.000Z",
    });
    expect(service.update(photo.id, { caption: null }).caption).toBeNull();
    await expect(service.delete(photo.id)).resolves.toEqual({
      deleted: true,
      photo_id: photo.id,
      brew_id: brewId,
    });
    expect(existsSync(photo.file_path)).toBe(false);
    expect(existsSync(photo.thumbnail_file_path)).toBe(false);
    expect(service.list({ brew_id: brewId })).toEqual([]);
  });

  it("requires attached photos to be removed before deleting a brew", async () => {
    const photo = await service.add({ brew_id: brewId, source_path: sourcePath });
    expect(() => repository.deleteBrew(brewId)).toThrow("delete attached brew photos");
    await service.delete(photo.id);
    expect(repository.deleteBrew(brewId)).toEqual({ deleted: true, brew_id: brewId });
  });

  it("rejects unsupported files and unknown brews without retaining output", async () => {
    const textPath = join(directory, "not-an-image.txt");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(textPath, "not an image"));
    await expect(service.add({ brew_id: brewId, source_path: textPath })).rejects.toThrow("readable supported image");
    await expect(service.add({ brew_id: 999, source_path: sourcePath })).rejects.toThrow("unknown brew ID");
    expect(service.list()).toEqual([]);
  });
});
