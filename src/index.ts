import { join } from "node:path";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  BODY_LEVELS,
  BREW_CONTEXTS,
  DRINK_TYPES,
  MILK_TEXTURES,
  PROVENANCE_KINDS,
  TASTE_BALANCES,
} from "./domain.js";
import { BrewPhotoService } from "./photo-service.js";
import { CoffeeRepository } from "./repository.js";

const ContextSchema = Type.Union(
  BREW_CONTEXTS.map((value) => Type.Literal(value)),
  { description: "Brew context: espresso or filter." },
);
const DrinkTypeSchema = Type.Union(
  DRINK_TYPES.map((value) => Type.Literal(value)),
  { description: "Kind of coffee drink or brew method." },
);
const IdSchema = (description: string) => Type.Integer({ minimum: 1, description });
const BagIdSchema = IdSchema("Numeric bag ID returned by Coffee Tracker.");
const CoffeeIdSchema = IdSchema("Numeric reusable coffee identity ID returned by Coffee Tracker.");
const BrewIdSchema = IdSchema("Numeric brew ID returned by Coffee Tracker.");
const PhotoIdSchema = IdSchema("Numeric photo ID returned by Coffee Tracker.");
const LimitSchema = Type.Integer({ minimum: 1, maximum: 100, description: "Maximum records to return (1–100)." });
const RatingSchema = Type.Integer({ minimum: 1, maximum: 5, description: "Rating on a 1–5 scale." });
const TasteBalanceSchema = Type.Union(TASTE_BALANCES.map((value) => Type.Literal(value)));
const BodyLevelSchema = Type.Union(BODY_LEVELS.map((value) => Type.Literal(value)));
const MilkTextureSchema = Type.Union(MILK_TEXTURES.map((value) => Type.Literal(value)));
const ProvenanceKindSchema = Type.Union(PROVENANCE_KINDS.map((value) => Type.Literal(value)));
const ProvenanceSchema = Type.Record(Type.String({ minLength: 1 }), Type.Object({
  kind: ProvenanceKindSchema,
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
}, { additionalProperties: false }), { description: "Per-field provenance. Mark inferred or approximate values explicitly and explain the basis in note." });
const PositiveNumberSchema = (description: string) => Type.Number({ exclusiveMinimum: 0, description });
const NullableTextSchema = (description: string) => Type.Union([Type.String({ minLength: 1, description }), Type.Null()]);
const NullableDateSchema = Type.Union([
  Type.String({ description: "Date as YYYY-MM-DD." }),
  Type.Null({ description: "Clear the date." }),
]);
const NullablePositiveSchema = (description: string) => Type.Union([PositiveNumberSchema(description), Type.Null()]);
const NullableRatingSchema = Type.Union([RatingSchema, Type.Null()]);

const CoffeeFields = {
  roaster: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  origin: Type.Optional(Type.String({ minLength: 1 })),
  process: Type.Optional(Type.String({ minLength: 1 })),
  notes: Type.Optional(Type.String({ minLength: 1 })),
};
const BagFields = {
  roast_date: Type.Optional(Type.String({ description: "Roast date as YYYY-MM-DD." })),
  opened_date: Type.Optional(Type.String({ description: "Opened date as YYYY-MM-DD." })),
  finished_date: Type.Optional(Type.String({ description: "Finished date as YYYY-MM-DD." })),
  size_g: Type.Optional(PositiveNumberSchema("Original bag size in grams.")),
};
const BrewFilterFields = {
  bag_id: Type.Optional(BagIdSchema),
  coffee_id: Type.Optional(CoffeeIdSchema),
  drink_type: Type.Optional(DrinkTypeSchema),
  start_date: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD in configured timezone, or ISO 8601 timestamp." })),
  end_date: Type.Optional(Type.String({ description: "Inclusive YYYY-MM-DD in configured timezone, or ISO 8601 timestamp." })),
  minimum_rating: Type.Optional(RatingSchema),
};

function databasePath(context: { api: { runtime: { state: { resolveStateDir(env: NodeJS.ProcessEnv): string } } } }): string {
  return join(context.api.runtime.state.resolveStateDir(process.env), "plugins", "coffee-tracker", "coffee-tracker.sqlite");
}

function withRepository<T>(
  context: Parameters<typeof databasePath>[0],
  timeZone: string | undefined,
  operation: (repository: CoffeeRepository) => T,
): T {
  const repository = new CoffeeRepository(databasePath(context), timeZone);
  try {
    return operation(repository);
  } finally {
    repository.close();
  }
}

async function withPhotoService<T>(
  context: Parameters<typeof databasePath>[0],
  timeZone: string | undefined,
  operation: (service: BrewPhotoService) => Promise<T> | T,
): Promise<T> {
  const path = databasePath(context);
  const repository = new CoffeeRepository(path, timeZone);
  try {
    return await operation(new BrewPhotoService(repository, path));
  } finally {
    repository.close();
  }
}

export default defineToolPlugin({
  id: "coffee-tracker",
  name: "Coffee Tracker",
  description: "Persist and query a local coffee, bag, brew, and photo journal.",
  configSchema: Type.Object({
    timezone: Type.Optional(Type.String({ description: "IANA timezone used for date-only brew searches, such as America/Chicago." })),
  }, { additionalProperties: false }),
  tools: (tool) => [
    tool({
      name: "coffee_add_bean",
      label: "Add Coffee and Bag",
      description: "Convenience tool that creates a reusable coffee identity and its first physical bag. Returns the bag ID used for brews and current selection.",
      parameters: Type.Object({
        ...CoffeeFields,
        ...BagFields,
        bag_notes: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => repository.addBean(params)),
    }),
    tool({
      name: "coffee_add_coffee",
      label: "Add Coffee Identity",
      description: "Create a reusable coffee identity. Use coffee_add_bag for each purchase of that coffee.",
      parameters: Type.Object(CoffeeFields, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => repository.addCoffee(params)),
    }),
    tool({
      name: "coffee_add_bag",
      label: "Add Coffee Bag",
      description: "Record a physical bag of an existing coffee, including its roast/open/finish dates and size.",
      parameters: Type.Object({
        coffee_id: CoffeeIdSchema,
        ...BagFields,
        notes: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => repository.addBag(params)),
    }),
    tool({
      name: "coffee_list_coffees",
      label: "List Coffee Identities",
      description: "List reusable coffee identities newest first with cursor pagination.",
      parameters: Type.Object({
        before_id: Type.Optional(CoffeeIdSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => ({ coffees: repository.listCoffees(params) })),
    }),
    tool({
      name: "coffee_list_bags",
      label: "List Coffee Bags",
      description: "List physical bags newest first. Finished bags are excluded unless requested.",
      parameters: Type.Object({
        context: Type.Optional(ContextSchema),
        coffee_id: Type.Optional(CoffeeIdSchema),
        include_finished: Type.Optional(Type.Boolean()),
        before_id: Type.Optional(BagIdSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => ({ bags: repository.listBags(params) })),
    }),
    tool({
      name: "coffee_list_beans",
      label: "List Coffee Bags (Legacy)",
      description: "Compatibility alias for listing active physical bags.",
      parameters: Type.Object({ context: Type.Optional(ContextSchema), limit: Type.Optional(LimitSchema) }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => ({ bags: repository.listBeans(params) })),
    }),
    tool({
      name: "coffee_update_coffee",
      label: "Update Coffee Identity",
      description: "Correct reusable coffee metadata. Null clears an optional field.",
      parameters: Type.Object({
        coffee_id: CoffeeIdSchema,
        roaster: Type.Optional(Type.String({ minLength: 1 })),
        name: Type.Optional(Type.String({ minLength: 1 })),
        origin: Type.Optional(NullableTextSchema("Origin; null clears it.")),
        process: Type.Optional(NullableTextSchema("Process; null clears it.")),
        notes: Type.Optional(NullableTextSchema("Notes; null clears them.")),
      }, { additionalProperties: false }),
      execute: ({ coffee_id, ...params }, config, context) => withRepository(context, config.timezone, (repository) => repository.updateCoffee(coffee_id, params)),
    }),
    tool({
      name: "coffee_update_bag",
      label: "Update Coffee Bag",
      description: "Correct bag metadata or mark a bag finished. Null clears an optional field.",
      parameters: Type.Object({
        bag_id: BagIdSchema,
        roast_date: Type.Optional(NullableDateSchema),
        opened_date: Type.Optional(NullableDateSchema),
        finished_date: Type.Optional(NullableDateSchema),
        size_g: Type.Optional(NullablePositiveSchema("Original bag size in grams; null clears it.")),
        notes: Type.Optional(NullableTextSchema("Bag notes; null clears them.")),
      }, { additionalProperties: false }),
      execute: ({ bag_id, ...params }, config, context) => withRepository(context, config.timezone, (repository) => repository.updateBag(bag_id, params)),
    }),
    tool({
      name: "coffee_set_current_bean",
      label: "Set Current Coffee Bag",
      description: "Select an existing physical bag as current for espresso or filter brewing. bean_id is the bag ID for compatibility.",
      parameters: Type.Object({ bean_id: BagIdSchema, context: ContextSchema }, { additionalProperties: false }),
      execute: ({ bean_id, context: brewContext }, config, context) => withRepository(context, config.timezone, (repository) => repository.setCurrentBean(bean_id, brewContext)),
    }),
    tool({
      name: "coffee_get_current_bean",
      label: "Get Current Coffee Bag",
      description: "Get the current physical bag for espresso or filter.",
      parameters: Type.Object({ context: ContextSchema }, { additionalProperties: false }),
      execute: ({ context: brewContext }, config, context) => withRepository(context, config.timezone, (repository) => repository.getCurrentBean(brewContext)),
    }),
    tool({
      name: "coffee_unset_current_bean",
      label: "Unset Current Coffee Bag",
      description: "Clear the current physical bag for a brew context.",
      parameters: Type.Object({ context: ContextSchema }, { additionalProperties: false }),
      execute: ({ context: brewContext }, config, context) => withRepository(context, config.timezone, (repository) => repository.unsetCurrentBean(brewContext)),
    }),
    tool({
      name: "coffee_log_brew",
      label: "Log Coffee Brew",
      description: "Record a brew using an explicit bag_id or selected context. Capture structured taste, body, milk, and latte-art feedback when supplied. Inferences are allowed only when explicitly identified in provenance with a correction-friendly note; never guess a bag.",
      parameters: Type.Object({
        bag_id: Type.Optional(BagIdSchema),
        context: Type.Optional(ContextSchema),
        timestamp: Type.Optional(Type.String({ description: "ISO 8601 brew timestamp. Omit for now." })),
        drink_type: DrinkTypeSchema,
        dose_g: Type.Optional(PositiveNumberSchema("Dry coffee dose in grams.")),
        yield_g: Type.Optional(PositiveNumberSchema("Beverage yield in grams.")),
        water_g: Type.Optional(PositiveNumberSchema("Brewing water in grams.")),
        grind_setting: Type.Optional(Type.String({ minLength: 1 })),
        grinder: Type.Optional(Type.String({ minLength: 1 })),
        brew_time_seconds: Type.Optional(PositiveNumberSchema("Total brew or shot time in seconds.")),
        water_temp_c: Type.Optional(PositiveNumberSchema("Water temperature in Celsius.")),
        rating: Type.Optional(RatingSchema),
        taste_balance: Type.Optional(TasteBalanceSchema),
        body_level: Type.Optional(BodyLevelSchema),
        milk_texture: Type.Optional(MilkTextureSchema),
        art_rating: Type.Optional(RatingSchema),
        provenance: Type.Optional(ProvenanceSchema),
        notes: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => repository.logBrew(params)),
    }),
    tool({
      name: "coffee_update_brew",
      label: "Update Coffee Brew",
      description: "Correct an existing brew. Null clears an optional measurement or note.",
      parameters: Type.Object({
        brew_id: BrewIdSchema,
        bag_id: Type.Optional(BagIdSchema),
        timestamp: Type.Optional(Type.String()),
        drink_type: Type.Optional(DrinkTypeSchema),
        dose_g: Type.Optional(NullablePositiveSchema("Dose; null clears it.")),
        yield_g: Type.Optional(NullablePositiveSchema("Yield; null clears it.")),
        water_g: Type.Optional(NullablePositiveSchema("Water; null clears it.")),
        grind_setting: Type.Optional(NullableTextSchema("Grind setting; null clears it.")),
        grinder: Type.Optional(NullableTextSchema("Grinder; null clears it.")),
        brew_time_seconds: Type.Optional(NullablePositiveSchema("Brew time; null clears it.")),
        water_temp_c: Type.Optional(NullablePositiveSchema("Water temperature; null clears it.")),
        rating: Type.Optional(NullableRatingSchema),
        taste_balance: Type.Optional(Type.Union([TasteBalanceSchema, Type.Null()])),
        body_level: Type.Optional(Type.Union([BodyLevelSchema, Type.Null()])),
        milk_texture: Type.Optional(Type.Union([MilkTextureSchema, Type.Null()])),
        art_rating: Type.Optional(NullableRatingSchema),
        provenance: Type.Optional(ProvenanceSchema),
        notes: Type.Optional(NullableTextSchema("Notes; null clears them.")),
      }, { additionalProperties: false }),
      execute: ({ brew_id, ...params }, config, context) => withRepository(context, config.timezone, (repository) => repository.updateBrew(brew_id, params)),
    }),
    tool({
      name: "coffee_delete_brew",
      label: "Delete Coffee Brew",
      description: "Permanently delete one mistaken brew. Attached photos must be deleted first. Requires explicit confirmation.",
      parameters: Type.Object({ brew_id: BrewIdSchema, confirm_deletion: Type.Literal(true) }, { additionalProperties: false }),
      execute: ({ brew_id }, config, context) => withRepository(context, config.timezone, (repository) => repository.deleteBrew(brew_id)),
    }),
    tool({
      name: "coffee_photo_add",
      label: "Attach Brew Photo",
      description: "Attach a staged local JPEG, PNG, or WebP image to a brew. The managed copy is orientation-corrected, metadata-stripped, and accompanied by a thumbnail.",
      parameters: Type.Object({
        brew_id: BrewIdSchema,
        source_path: Type.String({ minLength: 1, description: "Absolute or working-directory-relative path to the uploaded image file." }),
        caption: Type.Optional(Type.String({ minLength: 1 })),
        captured_at: Type.Optional(Type.String({ description: "ISO 8601 capture timestamp; defaults to the brew timestamp." })),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withPhotoService(context, config.timezone, (service) => service.add(params)),
    }),
    tool({
      name: "coffee_photo_list",
      label: "List Brew Photos",
      description: "List managed brew photos newest first, optionally for one brew, including full image and thumbnail paths.",
      parameters: Type.Object({
        brew_id: Type.Optional(BrewIdSchema),
        before_id: Type.Optional(PhotoIdSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withPhotoService(context, config.timezone, (service) => ({ photos: service.list(params) })),
    }),
    tool({
      name: "coffee_photo_update",
      label: "Update Brew Photo",
      description: "Correct a photo caption or capture timestamp. Null clears the caption.",
      parameters: Type.Object({
        photo_id: PhotoIdSchema,
        caption: Type.Optional(NullableTextSchema("Photo caption; null clears it.")),
        captured_at: Type.Optional(Type.String({ description: "ISO 8601 capture timestamp." })),
      }, { additionalProperties: false }),
      execute: ({ photo_id, ...params }, config, context) => withPhotoService(context, config.timezone, (service) => service.update(photo_id, params)),
    }),
    tool({
      name: "coffee_photo_delete",
      label: "Delete Brew Photo",
      description: "Permanently delete a managed photo, its thumbnail, and metadata. Requires explicit confirmation.",
      parameters: Type.Object({ photo_id: PhotoIdSchema, confirm_deletion: Type.Literal(true) }, { additionalProperties: false }),
      execute: ({ photo_id }, config, context) => withPhotoService(context, config.timezone, (service) => service.delete(photo_id)),
    }),
    tool({
      name: "coffee_get_recent_brews",
      label: "Get Recent Coffee Brews",
      description: "Get recent brews newest first with cursor pagination.",
      parameters: Type.Object({
        bag_id: Type.Optional(BagIdSchema),
        coffee_id: Type.Optional(CoffeeIdSchema),
        context: Type.Optional(ContextSchema),
        drink_type: Type.Optional(DrinkTypeSchema),
        before_brew_id: Type.Optional(BrewIdSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => ({ brews: repository.getRecentBrews(params) })),
    }),
    tool({
      name: "coffee_search_brews",
      label: "Search Coffee Brews",
      description: "Search structured brew history. Date-only boundaries use the configured local timezone.",
      parameters: Type.Object({
        ...BrewFilterFields,
        before_brew_id: Type.Optional(BrewIdSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => ({ brews: repository.searchBrews(params) })),
    }),
    tool({
      name: "coffee_get_brew_summary",
      label: "Summarize Coffee Brews",
      description: "Calculate deterministic averages and the best-rated brew for structured filters.",
      parameters: Type.Object({ ...BrewFilterFields }, { additionalProperties: false }),
      execute: (params, config, context) => withRepository(context, config.timezone, (repository) => repository.getBrewSummary(params)),
    }),
  ],
});
