import { join } from "node:path";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { BREW_CONTEXTS, DRINK_TYPES } from "./domain.js";
import { CoffeeRepository } from "./repository.js";

const ContextSchema = Type.Union(
  BREW_CONTEXTS.map((value) => Type.Literal(value)),
  { description: "Bean context: espresso or filter." },
);
const DrinkTypeSchema = Type.Union(
  DRINK_TYPES.map((value) => Type.Literal(value)),
  { description: "Kind of coffee drink or brew method." },
);
const BeanIdSchema = Type.Integer({ minimum: 1, description: "Numeric bean ID returned by coffee_add_bean or coffee_list_beans." });
const LimitSchema = Type.Integer({ minimum: 1, maximum: 100, description: "Maximum records to return (1–100)." });
const RatingSchema = Type.Integer({ minimum: 1, maximum: 5, description: "Rating on the Coffee Tracker 1–5 scale." });
const PositiveNumberSchema = (description: string) => Type.Number({ exclusiveMinimum: 0, description });

function databasePath(context: { api: { runtime: { state: { resolveStateDir(env: NodeJS.ProcessEnv): string } } } }): string {
  return join(context.api.runtime.state.resolveStateDir(process.env), "plugins", "coffee-tracker", "coffee-tracker.sqlite");
}

function withRepository<T>(context: Parameters<typeof databasePath>[0], operation: (repository: CoffeeRepository) => T): T {
  const repository = new CoffeeRepository(databasePath(context));
  try {
    return operation(repository);
  } finally {
    repository.close();
  }
}

export default defineToolPlugin({
  id: "coffee-tracker",
  name: "Coffee Tracker",
  description: "Persist and query a local coffee bean and brew journal.",
  tools: (tool) => [
    tool({
      name: "coffee_add_bean",
      label: "Add Coffee Bean",
      description: "Create a coffee bean or bag record when the user opens, buys, or wants to track a coffee. Returns its bean ID.",
      parameters: Type.Object({
        roaster: Type.String({ minLength: 1, description: "Roaster name, for example Onyx." }),
        name: Type.String({ minLength: 1, description: "Coffee or bag name; it need not be unique." }),
        origin: Type.Optional(Type.String({ minLength: 1, description: "Coffee origin, if known." })),
        process: Type.Optional(Type.String({ minLength: 1, description: "Processing method, if known." })),
        roast_date: Type.Optional(Type.String({ description: "Roast date in YYYY-MM-DD format." })),
        opened_date: Type.Optional(Type.String({ description: "Bag opening date in YYYY-MM-DD format." })),
        notes: Type.Optional(Type.String({ minLength: 1, description: "Free-form notes about the bean or bag." })),
      }, { additionalProperties: false }),
      execute: (params, _config, context) => withRepository(context, (repository) => repository.addBean(params)),
    }),
    tool({
      name: "coffee_list_beans",
      label: "List Coffee Beans",
      description: "List known coffee beans. Optionally return only the current bean for an espresso or filter context.",
      parameters: Type.Object({
        context: Type.Optional(ContextSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, _config, context) => withRepository(context, (repository) => ({
        beans: repository.listBeans(params),
      })),
    }),
    tool({
      name: "coffee_set_current_bean",
      label: "Set Current Coffee Bean",
      description: "Select an existing bean as the current bean for espresso or filter brewing.",
      parameters: Type.Object({
        bean_id: BeanIdSchema,
        context: ContextSchema,
      }, { additionalProperties: false }),
      execute: ({ bean_id, context: brewContext }, _config, context) => withRepository(
        context,
        (repository) => repository.setCurrentBean(bean_id, brewContext),
      ),
    }),
    tool({
      name: "coffee_get_current_bean",
      label: "Get Current Coffee Bean",
      description: "Get the current bean for espresso or filter. Returns configured=false and bean=null when none is selected.",
      parameters: Type.Object({ context: ContextSchema }, { additionalProperties: false }),
      execute: ({ context: brewContext }, _config, context) => withRepository(
        context,
        (repository) => repository.getCurrentBean(brewContext),
      ),
    }),
    tool({
      name: "coffee_log_brew",
      label: "Log Coffee Brew",
      description: "Record a brew or espresso shot. Provide bean_id, or provide context to use that context's current bean. Never guesses a bean.",
      parameters: Type.Object({
        bean_id: Type.Optional(BeanIdSchema),
        context: Type.Optional(ContextSchema),
        timestamp: Type.Optional(Type.String({ description: "ISO 8601 brew date/time. Omit to use the current time." })),
        drink_type: DrinkTypeSchema,
        dose_g: Type.Optional(PositiveNumberSchema("Dry coffee dose in grams.")),
        yield_g: Type.Optional(PositiveNumberSchema("Beverage yield in grams.")),
        water_g: Type.Optional(PositiveNumberSchema("Brewing water amount in grams.")),
        grind_setting: Type.Optional(Type.String({ minLength: 1, description: "Grind setting exactly as represented by the grinder, such as 4.3 or 12 clicks." })),
        grinder: Type.Optional(Type.String({ minLength: 1, description: "Grinder name or model." })),
        brew_time_seconds: Type.Optional(PositiveNumberSchema("Total brew or shot time in seconds.")),
        water_temp_c: Type.Optional(PositiveNumberSchema("Water temperature in degrees Celsius.")),
        rating: Type.Optional(RatingSchema),
        notes: Type.Optional(Type.String({ minLength: 1, description: "Taste observations or other factual brew notes." })),
      }, { additionalProperties: false }),
      execute: (params, _config, context) => withRepository(context, (repository) => repository.logBrew(params)),
    }),
    tool({
      name: "coffee_get_recent_brews",
      label: "Get Recent Coffee Brews",
      description: "Get recent brews newest first, optionally for a bean, current context, or drink type. Use for questions like 'last shot' or 'last five shots'.",
      parameters: Type.Object({
        bean_id: Type.Optional(BeanIdSchema),
        context: Type.Optional(ContextSchema),
        drink_type: Type.Optional(DrinkTypeSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, _config, context) => withRepository(context, (repository) => ({
        brews: repository.getRecentBrews(params),
      })),
    }),
    tool({
      name: "coffee_search_brews",
      label: "Search Coffee Brews",
      description: "Query structured brew history by bean, drink type, date range, and minimum 1–5 rating. Use for historical or best-rated brew questions; this is not semantic search.",
      parameters: Type.Object({
        bean_id: Type.Optional(BeanIdSchema),
        drink_type: Type.Optional(DrinkTypeSchema),
        start_date: Type.Optional(Type.String({ description: "Inclusive start as YYYY-MM-DD or ISO 8601 timestamp." })),
        end_date: Type.Optional(Type.String({ description: "Inclusive end as YYYY-MM-DD (whole day) or ISO 8601 timestamp." })),
        minimum_rating: Type.Optional(RatingSchema),
        limit: Type.Optional(LimitSchema),
      }, { additionalProperties: false }),
      execute: (params, _config, context) => withRepository(context, (repository) => ({
        brews: repository.searchBrews(params),
      })),
    }),
  ],
});
