import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, runPublicationCli } from "./publication.js";
import { CoffeeRepository } from "./repository.js";

let directory: string;
let databasePath: string;
let repository: CoffeeRepository;
let brewId: number;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "coffee-publication-"));
  databasePath = join(directory, "coffee-tracker.sqlite");
  repository = new CoffeeRepository(databasePath, "America/Chicago");
  const bag = repository.addBean({
    roaster: "Onyx",
    name: "Worka",
    origin: "Ethiopia",
    process: "washed",
    notes: "PRIVATE-COFFEE-NOTES",
    roast_date: "2026-09-15",
    opened_date: "2026-09-20",
    size_g: 340,
    bag_notes: "PRIVATE-BAG-NOTES",
  });
  brewId = repository.logBrew({
    bag_id: bag.id,
    timestamp: "2026-10-28T13:14:00Z",
    drink_type: "latte",
    dose_g: 18,
    yield_g: 38,
    brew_time_seconds: 29,
    grinder: "PRIVATE-GRINDER",
    grind_setting: "PRIVATE-GRIND-SETTING",
    rating: 4,
    art_rating: 3,
    taste_balance: "balanced",
    milk_texture: "good",
    notes: "PRIVATE-BREW-NOTES",
    provenance: { dose_g: { kind: "approximate", note: "PRIVATE-PROVENANCE" } },
  }).id;
  for (const [index, captured] of ["2026-10-28T13:20:00Z", "2026-10-28T13:15:00Z"].entries()) {
    repository.addBrewPhoto({
      brew_id: brewId,
      relative_path: `2026/10/photo-${index}.jpg`,
      thumbnail_relative_path: `2026/10/photo-${index}-thumb.webp`,
      original_filename: `PRIVATE-FILENAME-${index}.jpg`,
      mime_type: "image/jpeg",
      byte_size: 10,
      sha256: `${index}`.repeat(64),
      width: 10,
      height: 10,
      caption: index === 0 ? "Tulip" : undefined,
      captured_at: captured,
    });
  }
});

afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
});

function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runPublicationCli(argv, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("publication CLI", () => {
  it("projects one brew with public fields and photos in capture order", () => {
    const result = run("--db", databasePath, "get", String(brewId));
    expect(result.code).toBe(EXIT.ok);
    const projection = result.json();
    expect(projection).toMatchObject({
      projectionVersion: 1,
      source: { system: "coffee-tracker", recordId: String(brewId) },
      occurredAt: "2026-10-28T13:14:00.000Z",
      fields: {
        roaster: "Onyx",
        coffeeName: "Worka",
        origin: "Ethiopia",
        process: "washed",
        drinkType: "latte",
        doseG: 18,
        yieldG: 38,
        brewTimeSeconds: 29,
        tasteBalance: "balanced",
        milkTexture: "good",
      },
      optInFields: {},
    });
    expect(projection.fields).not.toHaveProperty("waterG");
    expect(projection.media).toEqual([
      { id: "photo-2", path: join(directory, "photos", "2026/10/photo-1.jpg"), mimeType: "image/jpeg" },
      { id: "photo-1", path: join(directory, "photos", "2026/10/photo-0.jpg"), mimeType: "image/jpeg", caption: "Tulip" },
    ]);
  });

  it("never projects private fields, and opt-in fields only when included", () => {
    const always = ["PRIVATE-COFFEE-NOTES", "PRIVATE-BAG-NOTES", "PRIVATE-GRINDER", "PRIVATE-GRIND-SETTING", "PRIVATE-PROVENANCE", "PRIVATE-FILENAME", "2026-09-15", "2026-09-20", "340"];
    const plain = run("--db", databasePath, "get", String(brewId)).stdout;
    for (const marker of [...always, "PRIVATE-BREW-NOTES"]) expect(plain).not.toContain(marker);
    expect(JSON.parse(plain).optInFields).toEqual({});

    const included = run("--db", databasePath, "get", String(brewId), "--include", "rating,artRating,notes");
    for (const marker of always) expect(included.stdout).not.toContain(marker);
    expect(included.json().optInFields).toEqual({ rating: 4, artRating: 3, notes: "PRIVATE-BREW-NOTES" });
    expect(run("--db", databasePath, "get", String(brewId), "--include", "rating").json().optInFields).toEqual({ rating: 4 });
  });

  it("uses distinct exit codes for usage errors and missing records", () => {
    expect(run("get", "1")).toMatchObject({ code: EXIT.usage, stderr: expect.stringContaining("usage") });
    expect(run("--db", databasePath, "get", "1", "--include", "grinder")).toMatchObject({ code: EXIT.usage, stderr: expect.stringContaining("grinder") });
    expect(run("--db", join(directory, "nope.sqlite"), "get", "1").code).toBe(EXIT.usage);
    expect(run("--db", databasePath, "get", "999")).toMatchObject({ code: EXIT.notFound, stderr: expect.stringContaining("unknown brew ID") });
    expect(run("--db", databasePath, "get", "../1").code).toBe(EXIT.notFound);
  });

  it("opens the database read-only and refuses an unmigrated schema", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { statSync } = await import("node:fs");
    const before = statSync(databasePath).mtimeMs;
    expect(run("--db", databasePath, "get", String(brewId)).code).toBe(EXIT.ok);
    expect(statSync(databasePath).mtimeMs).toBe(before);

    const db = new DatabaseSync(databasePath);
    db.exec("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)");
    db.close();
    expect(run("--db", databasePath, "get", String(brewId))).toMatchObject({ code: EXIT.failure, stderr: expect.stringContaining("migrations") });
  });

  it("does not create a database that does not exist", async () => {
    const missing = join(directory, "missing", "coffee-tracker.sqlite");
    run("--db", missing, "get", "1");
    expect((await import("node:fs")).existsSync(missing)).toBe(false);
  });
});
