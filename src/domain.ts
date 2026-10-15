export const BREW_CONTEXTS = ["espresso", "filter"] as const;
export type BrewContext = (typeof BREW_CONTEXTS)[number];

export const DRINK_TYPES = [
  "espresso",
  "americano",
  "cortado",
  "cappuccino",
  "latte",
  "pour_over",
  "drip",
  "aeropress",
  "other",
] as const;
export type DrinkType = (typeof DRINK_TYPES)[number];

export interface Coffee {
  id: number;
  roaster: string;
  name: string;
  origin: string | null;
  process: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Bag {
  id: number;
  coffee_id: number;
  roast_date: string | null;
  opened_date: string | null;
  finished_date: string | null;
  size_g: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BagWithCoffee extends Bag {
  coffee: Coffee;
}

export interface Brew {
  id: number;
  bag_id: number;
  timestamp: string;
  drink_type: DrinkType;
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
}

export interface BrewWithBag extends Brew {
  bag: BagWithCoffee;
  brew_ratio: number | null;
}

export interface BrewPhoto {
  id: number;
  brew_id: number;
  relative_path: string;
  thumbnail_relative_path: string;
  original_filename: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp";
  byte_size: number;
  sha256: string;
  width: number;
  height: number;
  caption: string | null;
  captured_at: string;
  created_at: string;
  updated_at: string;
}

export interface BrewPhotoWithPaths extends BrewPhoto {
  file_path: string;
  thumbnail_file_path: string;
}

export interface AddBrewPhotoRecord {
  brew_id: number;
  relative_path: string;
  thumbnail_relative_path: string;
  original_filename: string;
  mime_type: BrewPhoto["mime_type"];
  byte_size: number;
  sha256: string;
  width: number;
  height: number;
  caption?: string;
  captured_at?: string;
}

export interface UpdateBrewPhotoInput {
  caption?: string | null;
  captured_at?: string;
}

export interface AddCoffeeInput {
  roaster: string;
  name: string;
  origin?: string;
  process?: string;
  notes?: string;
}

export interface AddBagInput {
  coffee_id: number;
  roast_date?: string;
  opened_date?: string;
  finished_date?: string;
  size_g?: number;
  notes?: string;
}

export interface AddBeanInput extends AddCoffeeInput {
  roast_date?: string;
  opened_date?: string;
  finished_date?: string;
  size_g?: number;
  bag_notes?: string;
}

export interface UpdateCoffeeInput {
  roaster?: string;
  name?: string;
  origin?: string | null;
  process?: string | null;
  notes?: string | null;
}

export interface UpdateBagInput {
  roast_date?: string | null;
  opened_date?: string | null;
  finished_date?: string | null;
  size_g?: number | null;
  notes?: string | null;
}

export interface LogBrewInput {
  bag_id?: number;
  bean_id?: number;
  context?: BrewContext;
  timestamp?: string;
  drink_type: DrinkType;
  dose_g?: number;
  yield_g?: number;
  water_g?: number;
  grind_setting?: string;
  grinder?: string;
  brew_time_seconds?: number;
  water_temp_c?: number;
  rating?: number;
  notes?: string;
}

export interface UpdateBrewInput {
  bag_id?: number;
  timestamp?: string;
  drink_type?: DrinkType;
  dose_g?: number | null;
  yield_g?: number | null;
  water_g?: number | null;
  grind_setting?: string | null;
  grinder?: string | null;
  brew_time_seconds?: number | null;
  water_temp_c?: number | null;
  rating?: number | null;
  notes?: string | null;
}

export interface BrewFilters {
  bag_id?: number;
  bean_id?: number;
  coffee_id?: number;
  context?: BrewContext;
  drink_type?: DrinkType;
  start_date?: string;
  end_date?: string;
  minimum_rating?: number;
  before_brew_id?: number;
  limit?: number;
}

export class CoffeeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoffeeValidationError";
  }
}

export function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CoffeeValidationError(`${field} must not be blank`);
  return normalized;
}

export function optionalText(value: string | undefined, field: string): string | null {
  return value === undefined ? null : requireNonBlank(value, field);
}

export function nullableText(value: string | null, field: string): string | null;
export function nullableText(value: undefined, field: string): undefined;
export function nullableText(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireNonBlank(value, field);
}

export function normalizeDate(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CoffeeValidationError(`${field} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CoffeeValidationError(`${field} is not a valid calendar date`);
  }
  return value;
}

export function nullableDate(value: string | null, field: string): string | null;
export function nullableDate(value: undefined, field: string): undefined;
export function nullableDate(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return normalizeDate(value, field);
}

export function normalizeTimestamp(value: string | undefined, field = "timestamp"): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new CoffeeValidationError(`${field} must be a valid ISO 8601 timestamp`);
  }
  return parsed.toISOString();
}

export function validatePositive(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new CoffeeValidationError(`${field} must be greater than zero`);
  }
  return value;
}

export function nullablePositive(value: number | null, field: string): number | null;
export function nullablePositive(value: undefined, field: string): undefined;
export function nullablePositive(value: number | null | undefined, field: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  return validatePositive(value, field);
}

export function validateRating(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new CoffeeValidationError("rating must be an integer from 1 to 5");
  }
  return value;
}

export function nullableRating(value: number | null): number | null;
export function nullableRating(value: undefined): undefined;
export function nullableRating(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  return validateRating(value);
}

export function validateLimit(value: number | undefined, defaultValue: number): number {
  const limit = value ?? defaultValue;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CoffeeValidationError("limit must be an integer from 1 to 100");
  }
  return limit;
}
