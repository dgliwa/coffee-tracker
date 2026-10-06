import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  type AddBeanInput,
  type Bean,
  type Brew,
  type BrewContext,
  type BrewFilters,
  type BrewWithBean,
  CoffeeValidationError,
  type LogBrewInput,
  normalizeDate,
  normalizeTimestamp,
  optionalText,
  requireNonBlank,
  validateLimit,
  validatePositive,
  validateRating,
} from "./domain.js";

const BEAN_COLUMNS = `id, roaster, name, origin, process, roast_date, opened_date, notes, created_at, updated_at`;
const BREW_COLUMNS = `id, bean_id, timestamp, drink_type, dose_g, yield_g, water_g, grind_setting, grinder, brew_time_seconds, water_temp_c, rating, notes, created_at, updated_at`;

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
];

interface JoinedBrewRow extends Record<string, unknown> {
  id: number;
  bean_id: number;
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
  bean_roaster: string;
  bean_name: string;
  bean_origin: string | null;
  bean_process: string | null;
  bean_roast_date: string | null;
  bean_opened_date: string | null;
  bean_notes: string | null;
  bean_created_at: string;
  bean_updated_at: string;
}

export class CoffeeRepository {
  private readonly db: DatabaseSync;

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  addBean(input: AddBeanInput): Bean {
    const now = new Date().toISOString();
    const values = {
      roaster: requireNonBlank(input.roaster, "roaster"),
      name: requireNonBlank(input.name, "name"),
      origin: optionalText(input.origin, "origin"),
      process: optionalText(input.process, "process"),
      roastDate: normalizeDate(input.roast_date, "roast_date"),
      openedDate: normalizeDate(input.opened_date, "opened_date"),
      notes: optionalText(input.notes, "notes"),
    };
    const result = this.db.prepare(`
      INSERT INTO beans (roaster, name, origin, process, roast_date, opened_date, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(values.roaster, values.name, values.origin, values.process, values.roastDate, values.openedDate, values.notes, now, now);
    return this.getBean(Number(result.lastInsertRowid));
  }

  getBean(beanId: number): Bean {
    this.validateId(beanId, "bean_id");
    const row = this.db.prepare(`SELECT ${BEAN_COLUMNS} FROM beans WHERE id = ?`).get(beanId) as Bean | undefined;
    if (!row) throw new CoffeeValidationError(`unknown bean ID: ${beanId}`);
    return row;
  }

  listBeans(options: { context?: BrewContext; limit?: number } = {}): Bean[] {
    const limit = validateLimit(options.limit, 20);
    if (options.context) {
      return this.db.prepare(`
        SELECT ${BEAN_COLUMNS.split(", ").map((column) => `b.${column}`).join(", ")}
        FROM beans b JOIN current_beans c ON c.bean_id = b.id
        WHERE c.context = ? LIMIT ?
      `).all(options.context, limit) as unknown as Bean[];
    }
    return this.db.prepare(`SELECT ${BEAN_COLUMNS} FROM beans ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit) as unknown as Bean[];
  }

  setCurrentBean(beanId: number, context: BrewContext): { context: BrewContext; bean: Bean } {
    const bean = this.getBean(beanId);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO current_beans (context, bean_id, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(context) DO UPDATE SET bean_id = excluded.bean_id, updated_at = excluded.updated_at
      `).run(context, beanId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { context, bean };
  }

  getCurrentBean(context: BrewContext): { context: BrewContext; configured: boolean; bean: Bean | null } {
    const row = this.db.prepare(`
      SELECT ${BEAN_COLUMNS.split(", ").map((column) => `b.${column}`).join(", ")}
      FROM current_beans c JOIN beans b ON b.id = c.bean_id WHERE c.context = ?
    `).get(context) as Bean | undefined;
    return { context, configured: Boolean(row), bean: row ?? null };
  }

  logBrew(input: LogBrewInput): BrewWithBean {
    let beanId = input.bean_id;
    if (beanId === undefined && input.context !== undefined) {
      const current = this.getCurrentBean(input.context);
      if (!current.bean) throw new CoffeeValidationError(`no current ${input.context} bean configured`);
      beanId = current.bean.id;
    }
    if (beanId === undefined) {
      throw new CoffeeValidationError("bean_id is required when context cannot resolve a current bean");
    }
    this.getBean(beanId);

    const timestamp = normalizeTimestamp(input.timestamp);
    const now = new Date().toISOString();
    const dose = validatePositive(input.dose_g, "dose_g");
    const brewYield = validatePositive(input.yield_g, "yield_g");
    const water = validatePositive(input.water_g, "water_g");
    const brewTime = validatePositive(input.brew_time_seconds, "brew_time_seconds");
    const temperature = validatePositive(input.water_temp_c, "water_temp_c");
    const rating = validateRating(input.rating);
    const grind = optionalText(input.grind_setting, "grind_setting");
    const grinder = optionalText(input.grinder, "grinder");
    const notes = optionalText(input.notes, "notes");

    const result = this.db.prepare(`
      INSERT INTO brews (
        bean_id, timestamp, drink_type, dose_g, yield_g, water_g, grind_setting,
        grinder, brew_time_seconds, water_temp_c, rating, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(beanId, timestamp, input.drink_type, dose, brewYield, water, grind, grinder, brewTime, temperature, rating, notes, now, now);
    return this.getBrew(Number(result.lastInsertRowid));
  }

  getRecentBrews(filters: Pick<BrewFilters, "bean_id" | "context" | "drink_type" | "limit"> = {}): BrewWithBean[] {
    return this.queryBrews(filters, 5);
  }

  searchBrews(filters: BrewFilters): BrewWithBean[] {
    return this.queryBrews(filters, 10);
  }

  private getBrew(brewId: number): BrewWithBean {
    const rows = this.queryJoined("br.id = ?", [brewId], 1);
    const brew = rows[0];
    if (!brew) throw new CoffeeValidationError(`unknown brew ID: ${brewId}`);
    return brew;
  }

  private queryBrews(filters: BrewFilters, defaultLimit: number): BrewWithBean[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters.bean_id !== undefined) {
      this.getBean(filters.bean_id);
      clauses.push("br.bean_id = ?");
      params.push(filters.bean_id);
    }
    if (filters.context !== undefined) {
      const current = this.getCurrentBean(filters.context);
      if (!current.bean) throw new CoffeeValidationError(`no current ${filters.context} bean configured`);
      clauses.push("br.bean_id = ?");
      params.push(current.bean.id);
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
      const rating = validateRating(filters.minimum_rating);
      clauses.push("br.rating >= ?");
      params.push(rating!);
    }
    const where = clauses.length ? clauses.join(" AND ") : "1 = 1";
    return this.queryJoined(where, params, validateLimit(filters.limit, defaultLimit));
  }

  private queryJoined(where: string, params: SQLInputValue[], limit: number): BrewWithBean[] {
    const rows = this.db.prepare(`
      SELECT br.*,
        b.roaster AS bean_roaster, b.name AS bean_name, b.origin AS bean_origin,
        b.process AS bean_process, b.roast_date AS bean_roast_date,
        b.opened_date AS bean_opened_date, b.notes AS bean_notes,
        b.created_at AS bean_created_at, b.updated_at AS bean_updated_at
      FROM brews br JOIN beans b ON b.id = br.bean_id
      WHERE ${where}
      ORDER BY br.timestamp DESC, br.id DESC LIMIT ?
    `).all(...params, limit) as unknown as JoinedBrewRow[];
    return rows.map((row) => this.mapJoinedBrew(row));
  }

  private mapJoinedBrew(row: JoinedBrewRow): BrewWithBean {
    const brew = Object.fromEntries(BREW_COLUMNS.split(", ").map((column) => [column, row[column]])) as unknown as Brew;
    return {
      ...brew,
      bean: {
        id: row.bean_id,
        roaster: row.bean_roaster,
        name: row.bean_name,
        origin: row.bean_origin,
        process: row.bean_process,
        roast_date: row.bean_roast_date,
        opened_date: row.bean_opened_date,
        notes: row.bean_notes,
        created_at: row.bean_created_at,
        updated_at: row.bean_updated_at,
      },
      brew_ratio: row.dose_g !== null && row.yield_g !== null
        ? Number((row.yield_g / row.dose_g).toFixed(2))
        : null,
    };
  }

  private normalizeSearchBoundary(value: string, field: string, nextDay: boolean): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      normalizeDate(value, field);
      const date = new Date(`${value}T00:00:00.000Z`);
      if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString();
    }
    return normalizeTimestamp(value, field);
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
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version),
    );
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const version = index + 1;
      if (applied.has(version)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(MIGRATIONS[index]!);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
