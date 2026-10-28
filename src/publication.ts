import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoffeeValidationError, type BrewPhoto, type BrewWithBag } from "./domain.js";
import { CoffeeRepository } from "./repository.js";

/** Brew fields that are private unless a blog draft explicitly includes them. */
export const OPT_IN_FIELDS = ["rating", "artRating", "notes"] as const;
export type OptInField = (typeof OPT_IN_FIELDS)[number];

export const EXIT = { ok: 0, failure: 1, usage: 2, notFound: 3 } as const;

/**
 * Publication projection (version 1) consumed by openclaw-blog-publisher.
 * Grinder, grind setting, bag details, coffee/bag notes, provenance, and original
 * filenames are never projected.
 */
export interface BrewProjection {
  projectionVersion: 1;
  source: { system: "coffee-tracker"; recordId: string; version: string };
  occurredAt: string;
  fields: Record<string, string | number>;
  optInFields: Partial<Record<OptInField, string | number>>;
  media: Array<{ id: string; path: string; mimeType: BrewPhoto["mime_type"]; caption?: string }>;
}

function compact(values: Record<string, string | number | null>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== null));
}

export function projectBrew(
  brew: BrewWithBag,
  photos: readonly BrewPhoto[],
  photosRoot: string,
  include: readonly OptInField[] = [],
): BrewProjection {
  const coffee = brew.bag.coffee;
  const optIn: Record<OptInField, string | number | null> = {
    rating: brew.rating,
    artRating: brew.art_rating,
    notes: brew.notes,
  };
  return {
    projectionVersion: 1,
    source: { system: "coffee-tracker", recordId: String(brew.id), version: brew.updated_at },
    occurredAt: brew.timestamp,
    fields: compact({
      roaster: coffee.roaster,
      coffeeName: coffee.name,
      origin: coffee.origin,
      process: coffee.process,
      drinkType: brew.drink_type,
      doseG: brew.dose_g,
      yieldG: brew.yield_g,
      waterG: brew.water_g,
      brewRatio: brew.brew_ratio,
      brewTimeSeconds: brew.brew_time_seconds,
      waterTempC: brew.water_temp_c,
      tasteBalance: brew.taste_balance,
      bodyLevel: brew.body_level,
      milkTexture: brew.milk_texture,
    }),
    optInFields: compact(Object.fromEntries(include.map((field) => [field, optIn[field]]))),
    media: [...photos]
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.id - b.id)
      .map((photo) => ({
        id: `photo-${photo.id}`,
        path: join(photosRoot, photo.relative_path),
        mimeType: photo.mime_type,
        ...(photo.caption ? { caption: photo.caption } : {}),
      })),
  };
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = "usage: publication-cli --db <coffee-tracker.sqlite> get <brew-id> [--include rating,artRating,notes]\n";

/** `publication-cli --db <path> get <brew-id> [--include a,b]`; returns the process exit code. */
export function runPublicationCli(argv: readonly string[], io: CliIo): number {
  const args = [...argv];
  let databasePath: string | undefined;
  let include: string[] = [];
  const positional: string[] = [];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--db") databasePath = args.shift();
    else if (arg === "--include") include = (args.shift() ?? "").split(",").filter(Boolean);
    else positional.push(arg);
  }
  const [command, recordId] = positional;
  if (!databasePath || command !== "get" || !recordId || positional.length !== 2) {
    io.stderr(USAGE);
    return EXIT.usage;
  }
  const unknown = include.filter((field) => !(OPT_IN_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0) {
    io.stderr(`unknown opt-in field(s): ${unknown.join(", ")}\n`);
    return EXIT.usage;
  }
  if (!existsSync(databasePath)) {
    io.stderr("coffee-tracker database not found\n");
    return EXIT.usage;
  }
  if (!/^[1-9]\d*$/.test(recordId)) {
    io.stderr(`brew ID must be a positive integer: ${recordId}\n`);
    return EXIT.notFound;
  }

  let repository: CoffeeRepository;
  try {
    repository = new CoffeeRepository(databasePath, undefined, { readOnly: true });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failure;
  }
  try {
    const brewId = Number(recordId);
    const brew = repository.getBrew(brewId);
    const photos = repository.listBrewPhotos({ brew_id: brewId, limit: 100 });
    io.stdout(`${JSON.stringify(projectBrew(brew, photos, join(dirname(databasePath), "photos"), include as OptInField[]))}\n`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CoffeeValidationError && /unknown brew ID/.test(error.message)) {
      io.stderr(`${error.message}\n`);
      return EXIT.notFound;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failure;
  } finally {
    repository.close();
  }
}
