import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  type AddBagInput,
  type AddBeanInput,
  type AddBrewPhotoRecord,
  type AddCoffeeInput,
  type Bag,
  type BagWithCoffee,
  type Brew,
  type BrewContext,
  type BrewFilters,
  type BrewWithBag,
  type BrewPhoto,
  type BrewProvenance,
  type Coffee,
  CoffeeValidationError,
  type LogBrewInput,
  type UpdateBagInput,
  type UpdateBrewInput,
  type UpdateBrewPhotoInput,
  type UpdateCoffeeInput,
  normalizeDate,
  normalizeTimestamp,
  nullableDate,
  nullablePositive,
  nullableRating,
  nullableText,
  optionalText,
  requireNonBlank,
  validateLimit,
  validatePositive,
  validateProvenance,
  validateRating,
} from "./domain.js";

const BREW_COLUMNS = [
  "id", "bag_id", "timestamp", "drink_type", "dose_g", "yield_g", "water_g",
  "grind_setting", "grinder", "brew_time_seconds", "water_temp_c", "rating",
  "taste_balance", "body_level", "milk_texture", "art_rating", "provenance_json",
  "notes", "created_at", "updated_at",
] as const;

const MIGRATIONS = [
  `
    CREATE TABLE beans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roaster TEXT NOT NULL,
      name TEXT NOT NULL,
      origin TEXT,
      process TEXT,
      roast_date TEXT,
      opened_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE brews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bean_id INTEGER NOT NULL REFERENCES beans(id) ON DELETE RESTRICT,
      timestamp TEXT NOT NULL,
      drink_type TEXT NOT NULL,
      dose_g REAL,
      yield_g REAL,
      water_g REAL,
      grind_setting TEXT,
      grinder TEXT,
      brew_time_seconds REAL,
      water_temp_c REAL,
      rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE current_beans (
      context TEXT PRIMARY KEY CHECK (context IN ('espresso', 'filter')),
      bean_id INTEGER NOT NULL REFERENCES beans(id) ON DELETE RESTRICT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_brews_timestamp ON brews(timestamp DESC);
    CREATE INDEX idx_brews_bean_id ON brews(bean_id);
    CREATE INDEX idx_brews_drink_type ON brews(drink_type);
    CREATE INDEX idx_brews_bean_timestamp ON brews(bean_id, timestamp DESC);
  `,
  `
    CREATE TABLE coffees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roaster TEXT NOT NULL,
      name TEXT NOT NULL,
      origin TEXT,
      process TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO coffees(id, roaster, name, origin, process, notes, created_at, updated_at)
      SELECT id, roaster, name, origin, process, notes, created_at, updated_at FROM beans;

    CREATE TABLE bags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coffee_id INTEGER NOT NULL REFERENCES coffees(id) ON DELETE RESTRICT,
      roast_date TEXT,
      opened_date TEXT,
      finished_date TEXT,
      size_g REAL CHECK (size_g IS NULL OR size_g > 0),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO bags(id, coffee_id, roast_date, opened_date, created_at, updated_at)
      SELECT id, id, roast_date, opened_date, created_at, updated_at FROM beans;

    CREATE TABLE current_bags (
      context TEXT PRIMARY KEY CHECK (context IN ('espresso', 'filter')),
      bag_id INTEGER NOT NULL REFERENCES bags(id) ON DELETE RESTRICT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO current_bags(context, bag_id, updated_at)
      SELECT context, bean_id, updated_at FROM current_beans;

    CREATE TABLE brews_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bag_id INTEGER NOT NULL REFERENCES bags(id) ON DELETE RESTRICT,
      timestamp TEXT NOT NULL,
      drink_type TEXT NOT NULL,
      dose_g REAL,
      yield_g REAL,
      water_g REAL,
      grind_setting TEXT,
      grinder TEXT,
      brew_time_seconds REAL,
      water_temp_c REAL,
      rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO brews_v2(
      id, bag_id, timestamp, drink_type, dose_g, yield_g, water_g, grind_setting,
      grinder, brew_time_seconds, water_temp_c, rating, notes, created_at, updated_at
    ) SELECT
      id, bean_id, timestamp, drink_type, dose_g, yield_g, water_g, grind_setting,
      grinder, brew_time_seconds, water_temp_c, rating, notes, created_at, updated_at
    FROM brews;

    DROP TABLE current_beans;
    DROP TABLE brews;
    DROP TABLE beans;
    ALTER TABLE brews_v2 RENAME TO brews;
    CREATE INDEX idx_brews_timestamp ON brews(timestamp DESC);
    CREATE INDEX idx_brews_bag_id ON brews(bag_id);
    CREATE INDEX idx_brews_drink_type ON brews(drink_type);
    CREATE INDEX idx_brews_bag_timestamp ON brews(bag_id, timestamp DESC);
    CREATE INDEX idx_bags_coffee_id ON bags(coffee_id);
  `,
  `
    CREATE TABLE brew_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brew_id INTEGER NOT NULL REFERENCES brews(id) ON DELETE RESTRICT,
      relative_path TEXT NOT NULL UNIQUE,
      thumbnail_relative_path TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      sha256 TEXT NOT NULL,
      width INTEGER NOT NULL CHECK(width > 0),
      height INTEGER NOT NULL CHECK(height > 0),
      caption TEXT,
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(brew_id, sha256)
    );
    CREATE INDEX idx_brew_photos_brew_id ON brew_photos(brew_id, id DESC);
    CREATE INDEX idx_brew_photos_captured_at ON brew_photos(captured_at DESC, id DESC);
  `,
  `
    ALTER TABLE brews ADD COLUMN taste_balance TEXT CHECK(taste_balance IS NULL OR taste_balance IN ('sour', 'balanced', 'bitter', 'mixed'));
    ALTER TABLE brews ADD COLUMN body_level TEXT CHECK(body_level IS NULL OR body_level IN ('thin', 'good', 'heavy'));
    ALTER TABLE brews ADD COLUMN milk_texture TEXT CHECK(milk_texture IS NULL OR milk_texture IN ('thin', 'good', 'thick'));
    ALTER TABLE brews ADD COLUMN art_rating INTEGER CHECK(art_rating IS NULL OR art_rating BETWEEN 1 AND 5);
    ALTER TABLE brews ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
  `,
];

interface JoinedBrewRow extends Record<string, unknown> {
  id: number;
  bag_id: number;
  timestamp: string;
  drink_type: Brew["drink_type"];
  dose_g: number | null;
  yield_g: number | null;
  water_g: number | null;
  grind_setting: string | null;
  grinder: string | null;
  brew_time_seconds: number | null;
  water_temp_c: number | null;
  rating: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  bag_coffee_id: number;
  bag_roast_date: string | null;
  bag_opened_date: string | null;
  bag_finished_date: string | null;
  bag_size_g: number | null;
  bag_notes: string | null;
  bag_created_at: string;
  bag_updated_at: string;
  coffee_roaster: string;
  coffee_name: string;
  coffee_origin: string | null;
  coffee_process: string | null;
  coffee_notes: string | null;
  coffee_created_at: string;
  coffee_updated_at: string;
}

export class CoffeeRepository {
  private readonly db: DatabaseSync;
  readonly timeZone: string;

  /** With `readOnly`, never creates, migrates, or writes; the schema must already be current. */
  constructor(
    readonly databasePath: string,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    options: { readOnly?: boolean } = {},
  ) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
    } catch {
      throw new CoffeeValidationError(`invalid IANA timezone: ${timeZone}`);
    }
    this.timeZone = timeZone;
    if (options.readOnly) {
      this.db = new DatabaseSync(databasePath, { readOnly: true });
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.assertMigrated();
      return;
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private assertMigrated(): void {
    const { applied } = this.db.prepare("SELECT COUNT(*) AS applied FROM schema_migrations").get() as { applied: number };
    if (Number(applied) !== MIGRATIONS.length) {
      this.db.close();
      throw new Error(`coffee-tracker schema is at ${applied}/${MIGRATIONS.length} migrations; open it with the plugin first`);
    }
  }

  close(): void {
    this.db.close();
  }

  addCoffee(input: AddCoffeeInput): Coffee {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO coffees(roaster, name, origin, process, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireNonBlank(input.roaster, "roaster"),
      requireNonBlank(input.name, "name"),
      optionalText(input.origin, "origin"),
      optionalText(input.process, "process"),
      optionalText(input.notes, "notes"),
      now,
      now,
    );
    return this.getCoffee(Number(result.lastInsertRowid));
  }

  addBag(input: AddBagInput): BagWithCoffee {
    this.getCoffee(input.coffee_id);
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO bags(
        coffee_id, roast_date, opened_date, finished_date, size_g, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.coffee_id,
      normalizeDate(input.roast_date, "roast_date"),
      normalizeDate(input.opened_date, "opened_date"),
      normalizeDate(input.finished_date, "finished_date"),
      validatePositive(input.size_g, "size_g"),
      optionalText(input.notes, "notes"),
      now,
      now,
    );
    return this.getBag(Number(result.lastInsertRowid));
  }

  addBean(input: AddBeanInput): BagWithCoffee {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const coffee = this.addCoffee(input);
      const bag = this.addBag({
        coffee_id: coffee.id,
        roast_date: input.roast_date,
        opened_date: input.opened_date,
        finished_date: input.finished_date,
        size_g: input.size_g,
        notes: input.bag_notes,
      });
      this.db.exec("COMMIT");
      return bag;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCoffee(coffeeId: number): Coffee {
    this.validateId(coffeeId, "coffee_id");
    const row = this.db.prepare("SELECT * FROM coffees WHERE id = ?").get(coffeeId) as Coffee | undefined;
    if (!row) throw new CoffeeValidationError(`unknown coffee ID: ${coffeeId}`);
    return row;
  }

  getBag(bagId: number): BagWithCoffee {
    this.validateId(bagId, "bag_id");
    const row = this.db.prepare(`
      SELECT b.*, c.roaster, c.name, c.origin, c.process, c.notes AS coffee_notes,
        c.created_at AS coffee_created_at, c.updated_at AS coffee_updated_at
      FROM bags b JOIN coffees c ON c.id = b.coffee_id WHERE b.id = ?
    `).get(bagId) as (Bag & {
      roaster: string; name: string; origin: string | null; process: string | null;
      coffee_notes: string | null; coffee_created_at: string; coffee_updated_at: string;
    }) | undefined;
    if (!row) throw new CoffeeValidationError(`unknown bag ID: ${bagId}`);
    return {
      id: row.id,
      coffee_id: row.coffee_id,
      roast_date: row.roast_date,
      opened_date: row.opened_date,
      finished_date: row.finished_date,
      size_g: row.size_g,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      coffee: {
        id: row.coffee_id,
        roaster: row.roaster,
        name: row.name,
        origin: row.origin,
        process: row.process,
        notes: row.coffee_notes,
        created_at: row.coffee_created_at,
        updated_at: row.coffee_updated_at,
      },
    };
  }

  listCoffees(options: { limit?: number; before_id?: number } = {}): Coffee[] {
    const limit = validateLimit(options.limit, 20);
    const before = options.before_id ?? Number.MAX_SAFE_INTEGER;
    this.validateId(before, "before_id");
    return this.db.prepare(`
      SELECT * FROM coffees WHERE id < ? ORDER BY id DESC LIMIT ?
    `).all(before, limit) as unknown as Coffee[];
  }

  listBags(options: {
    context?: BrewContext;
    coffee_id?: number;
    include_finished?: boolean;
    before_id?: number;
    limit?: number;
  } = {}): BagWithCoffee[] {
    const clauses = ["b.id < ?"];
    const params: SQLInputValue[] = [options.before_id ?? Number.MAX_SAFE_INTEGER];
    if (options.context) {
      clauses.push("b.id = (SELECT bag_id FROM current_bags WHERE context = ?)");
      params.push(options.context);
    }
    if (options.coffee_id !== undefined) {
      this.getCoffee(options.coffee_id);
      clauses.push("b.coffee_id = ?");
      params.push(options.coffee_id);
    }
    if (!options.include_finished) clauses.push("b.finished_date IS NULL");
    const ids = this.db.prepare(`
      SELECT b.id FROM bags b WHERE ${clauses.join(" AND ")} ORDER BY b.id DESC LIMIT ?
    `).all(...params, validateLimit(options.limit, 20)) as unknown as Array<{ id: number }>;
    return ids.map(({ id }) => this.getBag(id));
  }

  listBeans(options: { context?: BrewContext; limit?: number } = {}): BagWithCoffee[] {
    return this.listBags(options);
  }

  updateCoffee(coffeeId: number, input: UpdateCoffeeInput): Coffee {
    const current = this.getCoffee(coffeeId);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE coffees SET roaster = ?, name = ?, origin = ?, process = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.roaster === undefined ? current.roaster : requireNonBlank(input.roaster, "roaster"),
      input.name === undefined ? current.name : requireNonBlank(input.name, "name"),
      input.origin === undefined ? current.origin : nullableText(input.origin, "origin"),
      input.process === undefined ? current.process : nullableText(input.process, "process"),
      input.notes === undefined ? current.notes : nullableText(input.notes, "notes"),
      now,
      coffeeId,
    );
    return this.getCoffee(coffeeId);
  }

  updateBag(bagId: number, input: UpdateBagInput): BagWithCoffee {
    const current = this.getBag(bagId);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE bags SET roast_date = ?, opened_date = ?, finished_date = ?, size_g = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.roast_date === undefined ? current.roast_date : nullableDate(input.roast_date, "roast_date"),
      input.opened_date === undefined ? current.opened_date : nullableDate(input.opened_date, "opened_date"),
      input.finished_date === undefined ? current.finished_date : nullableDate(input.finished_date, "finished_date"),
      input.size_g === undefined ? current.size_g : nullablePositive(input.size_g, "size_g"),
      input.notes === undefined ? current.notes : nullableText(input.notes, "notes"),
      now,
      bagId,
    );
    return this.getBag(bagId);
  }

  setCurrentBean(bagId: number, context: BrewContext): { context: BrewContext; bag: BagWithCoffee } {
    const bag = this.getBag(bagId);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO current_bags(context, bag_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(context) DO UPDATE SET bag_id = excluded.bag_id, updated_at = excluded.updated_at
    `).run(context, bagId, now);
    return { context, bag };
  }

  unsetCurrentBean(context: BrewContext): { context: BrewContext; configured: false; bag: null } {
    this.db.prepare("DELETE FROM current_bags WHERE context = ?").run(context);
    return { context, configured: false, bag: null };
  }

  getCurrentBean(context: BrewContext): {
    context: BrewContext;
    configured: boolean;
    bag: BagWithCoffee | null;
  } {
    const row = this.db.prepare("SELECT bag_id FROM current_bags WHERE context = ?").get(context) as { bag_id: number } | undefined;
    return { context, configured: Boolean(row), bag: row ? this.getBag(row.bag_id) : null };
  }

  logBrew(input: LogBrewInput): BrewWithBag {
    let bagId = input.bag_id ?? input.bean_id;
    if (input.bag_id !== undefined && input.bean_id !== undefined && input.bag_id !== input.bean_id) {
      throw new CoffeeValidationError("bag_id and legacy bean_id must match when both supplied");
    }
    if (bagId === undefined && input.context !== undefined) {
      const current = this.getCurrentBean(input.context);
      if (!current.bag) throw new CoffeeValidationError(`no current ${input.context} bag configured`);
      bagId = current.bag.id;
    }
    if (bagId === undefined) throw new CoffeeValidationError("bag_id is required when context cannot resolve a current bag");
    this.getBag(bagId);
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO brews(
        bag_id, timestamp, drink_type, dose_g, yield_g, water_g, grind_setting,
        grinder, brew_time_seconds, water_temp_c, rating, taste_balance, body_level,
        milk_texture, art_rating, provenance_json, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bagId,
      normalizeTimestamp(input.timestamp),
      input.drink_type,
      validatePositive(input.dose_g, "dose_g"),
      validatePositive(input.yield_g, "yield_g"),
      validatePositive(input.water_g, "water_g"),
      optionalText(input.grind_setting, "grind_setting"),
      optionalText(input.grinder, "grinder"),
      validatePositive(input.brew_time_seconds, "brew_time_seconds"),
      validatePositive(input.water_temp_c, "water_temp_c"),
      validateRating(input.rating),
      input.taste_balance ?? null,
      input.body_level ?? null,
      input.milk_texture ?? null,
      validateRating(input.art_rating),
      JSON.stringify(validateProvenance(input.provenance)),
      optionalText(input.notes, "notes"),
      now,
      now,
    );
    return this.getBrew(Number(result.lastInsertRowid));
  }

  updateBrew(brewId: number, input: UpdateBrewInput): BrewWithBag {
    const current = this.getBrew(brewId);
    if (input.bag_id !== undefined) this.getBag(input.bag_id);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE brews SET
        bag_id = ?, timestamp = ?, drink_type = ?, dose_g = ?, yield_g = ?, water_g = ?, grind_setting = ?,
        grinder = ?, brew_time_seconds = ?, water_temp_c = ?, rating = ?, taste_balance = ?, body_level = ?,
        milk_texture = ?, art_rating = ?, provenance_json = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.bag_id ?? current.bag_id,
      input.timestamp === undefined ? current.timestamp : normalizeTimestamp(input.timestamp),
      input.drink_type ?? current.drink_type,
      input.dose_g === undefined ? current.dose_g : nullablePositive(input.dose_g, "dose_g"),
      input.yield_g === undefined ? current.yield_g : nullablePositive(input.yield_g, "yield_g"),
      input.water_g === undefined ? current.water_g : nullablePositive(input.water_g, "water_g"),
      input.grind_setting === undefined ? current.grind_setting : nullableText(input.grind_setting, "grind_setting"),
      input.grinder === undefined ? current.grinder : nullableText(input.grinder, "grinder"),
      input.brew_time_seconds === undefined ? current.brew_time_seconds : nullablePositive(input.brew_time_seconds, "brew_time_seconds"),
      input.water_temp_c === undefined ? current.water_temp_c : nullablePositive(input.water_temp_c, "water_temp_c"),
      input.rating === undefined ? current.rating : nullableRating(input.rating),
      input.taste_balance === undefined ? current.taste_balance : input.taste_balance,
      input.body_level === undefined ? current.body_level : input.body_level,
      input.milk_texture === undefined ? current.milk_texture : input.milk_texture,
      input.art_rating === undefined ? current.art_rating : nullableRating(input.art_rating),
      JSON.stringify(input.provenance === undefined ? current.provenance : validateProvenance(input.provenance)),
      input.notes === undefined ? current.notes : nullableText(input.notes, "notes"),
      now,
      brewId,
    );
    return this.getBrew(brewId);
  }

  addBrewPhoto(input: AddBrewPhotoRecord): BrewPhoto {
    const brew = this.getBrew(input.brew_id);
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO brew_photos(
        brew_id, relative_path, thumbnail_relative_path, original_filename,
        mime_type, byte_size, sha256, width, height, caption, captured_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.brew_id,
      requireNonBlank(input.relative_path, "relative_path"),
      requireNonBlank(input.thumbnail_relative_path, "thumbnail_relative_path"),
      requireNonBlank(input.original_filename, "original_filename"),
      input.mime_type,
      input.byte_size,
      requireNonBlank(input.sha256, "sha256"),
      input.width,
      input.height,
      optionalText(input.caption, "caption"),
      normalizeTimestamp(input.captured_at ?? brew.timestamp),
      now,
      now,
    );
    return this.getBrewPhoto(Number(result.lastInsertRowid));
  }

  getBrewPhoto(photoId: number): BrewPhoto {
    this.validateId(photoId, "photo_id");
    const row = this.db.prepare(`
      SELECT id, brew_id, relative_path, thumbnail_relative_path, original_filename,
             mime_type, byte_size, sha256, width, height, caption, captured_at,
             created_at, updated_at
      FROM brew_photos WHERE id = ?
    `).get(photoId) as BrewPhoto | undefined;
    if (!row) throw new CoffeeValidationError(`unknown photo ID: ${photoId}`);
    return { ...row, byte_size: Number(row.byte_size), width: Number(row.width), height: Number(row.height) };
  }

  listBrewPhotos(options: { brew_id?: number; before_id?: number; limit?: number } = {}): BrewPhoto[] {
    const clauses = ["id < ?"];
    const params: SQLInputValue[] = [options.before_id ?? Number.MAX_SAFE_INTEGER];
    if (options.before_id !== undefined) this.validateId(options.before_id, "before_id");
    if (options.brew_id !== undefined) {
      this.getBrew(options.brew_id);
      clauses.push("brew_id = ?");
      params.push(options.brew_id);
    }
    const rows = this.db.prepare(`
      SELECT id, brew_id, relative_path, thumbnail_relative_path, original_filename,
             mime_type, byte_size, sha256, width, height, caption, captured_at,
             created_at, updated_at
      FROM brew_photos WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?
    `).all(...params, validateLimit(options.limit, 20)) as unknown as BrewPhoto[];
    return rows.map((row) => ({
      ...row,
      byte_size: Number(row.byte_size),
      width: Number(row.width),
      height: Number(row.height),
    }));
  }

  updateBrewPhoto(photoId: number, input: UpdateBrewPhotoInput): BrewPhoto {
    const current = this.getBrewPhoto(photoId);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE brew_photos SET caption = ?, captured_at = ?, updated_at = ? WHERE id = ?
    `).run(
      input.caption === undefined ? current.caption : nullableText(input.caption, "caption"),
      input.captured_at === undefined ? current.captured_at : normalizeTimestamp(input.captured_at),
      now,
      photoId,
    );
    return this.getBrewPhoto(photoId);
  }

  deleteBrewPhoto(photoId: number): BrewPhoto {
    const photo = this.getBrewPhoto(photoId);
    this.db.prepare("DELETE FROM brew_photos WHERE id = ?").run(photoId);
    return photo;
  }

  deleteBrew(brewId: number): { deleted: true; brew_id: number } {
    this.getBrew(brewId);
    const photoCount = this.db.prepare("SELECT COUNT(*) AS count FROM brew_photos WHERE brew_id = ?")
      .get(brewId) as { count: number };
    if (Number(photoCount.count) > 0) {
      throw new CoffeeValidationError("delete attached brew photos before deleting this brew");
    }
    this.db.prepare("DELETE FROM brews WHERE id = ?").run(brewId);
    return { deleted: true, brew_id: brewId };
  }

  getRecentBrews(filters: Pick<BrewFilters, "bag_id" | "bean_id" | "coffee_id" | "context" | "drink_type" | "before_brew_id" | "limit"> = {}): BrewWithBag[] {
    return this.queryBrews(filters, 5);
  }

  searchBrews(filters: BrewFilters): BrewWithBag[] {
    return this.queryBrews(filters, 10);
  }

  getBrewSummary(filters: BrewFilters = {}): {
    brew_count: number;
    average_dose_g: number | null;
    average_yield_g: number | null;
    average_ratio: number | null;
    average_brew_time_seconds: number | null;
    average_rating: number | null;
    average_art_rating: number | null;
    taste_counts: Record<string, number>;
    body_counts: Record<string, number>;
    milk_texture_counts: Record<string, number>;
    provenance_counts: Record<string, number>;
    best_rated_brew: BrewWithBag | null;
  } {
    const brews = this.queryBrews({ ...filters, limit: filters.limit ?? 100 }, 100);
    const average = (values: number[]) => values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
      : null;
    const counts = (values: Array<string | null>): Record<string, number> => values.reduce<Record<string, number>>((result, value) => {
      if (value) result[value] = (result[value] ?? 0) + 1;
      return result;
    }, {});
    const best = brews.filter((brew) => brew.rating !== null)
      .sort((left, right) => right.rating! - left.rating! || right.timestamp.localeCompare(left.timestamp))[0] ?? null;
    return {
      brew_count: brews.length,
      average_dose_g: average(brews.flatMap((brew) => brew.dose_g === null ? [] : [brew.dose_g])),
      average_yield_g: average(brews.flatMap((brew) => brew.yield_g === null ? [] : [brew.yield_g])),
      average_ratio: average(brews.flatMap((brew) => brew.brew_ratio === null ? [] : [brew.brew_ratio])),
      average_brew_time_seconds: average(brews.flatMap((brew) => brew.brew_time_seconds === null ? [] : [brew.brew_time_seconds])),
      average_rating: average(brews.flatMap((brew) => brew.rating === null ? [] : [brew.rating])),
      average_art_rating: average(brews.flatMap((brew) => brew.art_rating === null ? [] : [brew.art_rating])),
      taste_counts: counts(brews.map((brew) => brew.taste_balance)),
      body_counts: counts(brews.map((brew) => brew.body_level)),
      milk_texture_counts: counts(brews.map((brew) => brew.milk_texture)),
      provenance_counts: counts(brews.flatMap((brew) => Object.values(brew.provenance).map(({ kind }) => kind))),
      best_rated_brew: best,
    };
  }

  getBrew(brewId: number): BrewWithBag {
    this.validateId(brewId, "brew_id");
    const brew = this.queryJoined("br.id = ?", [brewId], 1)[0];
    if (!brew) throw new CoffeeValidationError(`unknown brew ID: ${brewId}`);
    return brew;
  }

  private queryBrews(filters: BrewFilters, defaultLimit: number): BrewWithBag[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    const bagId = filters.bag_id ?? filters.bean_id;
    if (filters.bag_id !== undefined && filters.bean_id !== undefined && filters.bag_id !== filters.bean_id) {
      throw new CoffeeValidationError("bag_id and legacy bean_id must match when both are supplied");
    }
    if (bagId !== undefined) {
      this.getBag(bagId);
      clauses.push("br.bag_id = ?");
      params.push(bagId);
    }
    if (filters.coffee_id !== undefined) {
      this.getCoffee(filters.coffee_id);
      clauses.push("b.coffee_id = ?");
      params.push(filters.coffee_id);
    }
    if (filters.context !== undefined) {
      const current = this.getCurrentBean(filters.context);
      if (!current.bag) throw new CoffeeValidationError(`no current ${filters.context} bag configured`);
      clauses.push("br.bag_id = ?");
      params.push(current.bag.id);
    }
    if (filters.drink_type !== undefined) {
      clauses.push("br.drink_type = ?");
      params.push(filters.drink_type);
    }
    if (filters.start_date !== undefined) {
      clauses.push("br.timestamp >= ?");
      params.push(this.normalizeSearchBoundary(filters.start_date, "start_date", false));
    }
    if (filters.end_date !== undefined) {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(filters.end_date);
      clauses.push(dateOnly ? "br.timestamp < ?" : "br.timestamp <= ?");
      params.push(this.normalizeSearchBoundary(filters.end_date, "end_date", dateOnly));
    }
    if (filters.minimum_rating !== undefined) {
      clauses.push("br.rating >= ?");
      params.push(validateRating(filters.minimum_rating)!);
    }
    if (filters.before_brew_id !== undefined) {
      const cursor = this.getBrew(filters.before_brew_id);
      clauses.push("(br.timestamp < ? OR (br.timestamp = ? AND br.id < ?))");
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    return this.queryJoined(
      clauses.length ? clauses.join(" AND ") : "1 = 1",
      params,
      validateLimit(filters.limit, defaultLimit),
    );
  }

  private queryJoined(where: string, params: SQLInputValue[], limit: number): BrewWithBag[] {
    const rows = this.db.prepare(`
      SELECT br.*,
        b.coffee_id AS bag_coffee_id, b.roast_date AS bag_roast_date,
        b.opened_date AS bag_opened_date, b.finished_date AS bag_finished_date,
        b.size_g AS bag_size_g, b.notes AS bag_notes,
        b.created_at AS bag_created_at, b.updated_at AS bag_updated_at,
        c.roaster AS coffee_roaster, c.name AS coffee_name, c.origin AS coffee_origin,
        c.process AS coffee_process, c.notes AS coffee_notes,
        c.created_at AS coffee_created_at, c.updated_at AS coffee_updated_at
      FROM brews br
      JOIN bags b ON b.id = br.bag_id
      JOIN coffees c ON c.id = b.coffee_id
      WHERE ${where}
      ORDER BY br.timestamp DESC, br.id DESC LIMIT ?
    `).all(...params, limit) as unknown as JoinedBrewRow[];
    return rows.map((row) => this.mapJoinedBrew(row));
  }

  private mapJoinedBrew(row: JoinedBrewRow): BrewWithBag {
    const record = Object.fromEntries(BREW_COLUMNS.map((column) => [column, row[column]]));
    const { provenance_json: rawProvenance, ...brew } = record;
    let provenance: BrewProvenance = {};
    try { provenance = JSON.parse(String(rawProvenance ?? "{}")) as BrewProvenance; } catch { provenance = {}; }
    return {
      ...(brew as unknown as Omit<Brew, "provenance">),
      provenance,
      bag: {
        id: row.bag_id,
        coffee_id: row.bag_coffee_id,
        roast_date: row.bag_roast_date,
        opened_date: row.bag_opened_date,
        finished_date: row.bag_finished_date,
        size_g: row.bag_size_g,
        notes: row.bag_notes,
        created_at: row.bag_created_at,
        updated_at: row.bag_updated_at,
        coffee: {
          id: row.bag_coffee_id,
          roaster: row.coffee_roaster,
          name: row.coffee_name,
          origin: row.coffee_origin,
          process: row.coffee_process,
          notes: row.coffee_notes,
          created_at: row.coffee_created_at,
          updated_at: row.coffee_updated_at,
        },
      },
      brew_ratio: row.dose_g !== null && row.yield_g !== null
        ? Number((row.yield_g / row.dose_g).toFixed(2))
        : null,
    };
  }

  private normalizeSearchBoundary(value: string, field: string, nextDay: boolean): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return normalizeTimestamp(value, field);
    normalizeDate(value, field);
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const target = new Date(Date.UTC(year, month - 1, day + (nextDay ? 1 : 0)));
    const targetParts = {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
    };
    let instant = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(instant))
          .filter(({ type }) => type !== "literal")
          .map(({ type, value: part }) => [type, Number(part)]),
      ) as Record<string, number>;
      const represented = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
      const wanted = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
      instant += wanted - represented;
    }
    return new Date(instant).toISOString();
  }

  private validateId(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CoffeeValidationError(`${field} must be a positive integer`);
    }
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
        .map(({ version }) => version),
    );
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const version = index + 1;
      if (applied.has(version)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(MIGRATIONS[index]!);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
