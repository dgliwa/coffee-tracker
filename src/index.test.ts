import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { CoffeeRepository } from "./repository.js";

const TOOL_NAMES = [
  "coffee_add_bean",
  "coffee_add_coffee",
  "coffee_add_bag",
  "coffee_list_coffees",
  "coffee_list_bags",
  "coffee_list_beans",
  "coffee_update_coffee",
  "coffee_update_bag",
  "coffee_set_current_bean",
  "coffee_get_current_bean",
  "coffee_unset_current_bean",
  "coffee_log_brew",
  "coffee_update_brew",
  "coffee_delete_brew",
  "coffee_photo_add",
  "coffee_photo_list",
  "coffee_photo_update",
  "coffee_photo_delete",
  "coffee_get_recent_brews",
  "coffee_search_brews",
  "coffee_get_brew_summary",
];

describe("coffee-tracker metadata", () => {
  it("declares the full tool surface", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });
});

describe("CoffeeRepository", () => {
  let directory: string;
  let databasePath: string;
  let repository: CoffeeRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "coffee-tracker-"));
    databasePath = join(directory, "test.sqlite");
    repository = new CoffeeRepository(databasePath, "America/Chicago");
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const addBag = (name = "Geometry") => repository.addBean({
    roaster: "Onyx",
    name,
    origin: "Ethiopia",
    roast_date: "2026-09-15",
    opened_date: "2026-09-20",
    size_g: 340,
  });

  it("separates reusable coffee identity from physical bags", () => {
    const coffee = repository.addCoffee({ roaster: "Onyx", name: "Geometry", origin: "Ethiopia" });
    const first = repository.addBag({ coffee_id: coffee.id, roast_date: "2026-09-01", size_g: 340 });
    const second = repository.addBag({ coffee_id: coffee.id, roast_date: "2026-10-01", size_g: 340 });

    expect(repository.listCoffees()).toHaveLength(1);
    expect(repository.listBags({ coffee_id: coffee.id }).map(({ id }) => id)).toEqual([second.id, first.id]);
    expect(first.coffee).toMatchObject({ id: coffee.id, name: "Geometry" });
  });

  it("keeps coffee_add_bean as a coffee-and-bag convenience", () => {
    const bag = addBag();
    expect(bag).toMatchObject({
      id: 1,
      coffee_id: 1,
      opened_date: "2026-09-20",
      coffee: { roaster: "Onyx", name: "Geometry" },
    });
  });

  it("updates coffee and bag fields, including explicit clearing", () => {
    const bag = addBag();
    expect(repository.updateCoffee(bag.coffee_id, { origin: "Kenya", process: "washed" }))
      .toMatchObject({ origin: "Kenya", process: "washed" });
    expect(repository.updateBag(bag.id, { finished_date: "2026-10-01", size_g: null }))
      .toMatchObject({ finished_date: "2026-10-01", size_g: null });
    expect(repository.listBags()).toEqual([]);
    expect(repository.listBags({ include_finished: true })).toHaveLength(1);
  });

  it("sets, resolves, and unsets current bags independently", () => {
    const espresso = addBag("Espresso");
    const filter = addBag("Filter");
    repository.setCurrentBean(espresso.id, "espresso");
    repository.setCurrentBean(filter.id, "filter");
    expect(repository.getCurrentBean("espresso").bag?.id).toBe(espresso.id);
    expect(repository.getCurrentBean("filter").bag?.id).toBe(filter.id);
    expect(repository.unsetCurrentBean("espresso")).toEqual({ context: "espresso", configured: false, bag: null });
    expect(repository.getCurrentBean("espresso").configured).toBe(false);
  });

  it("logs, corrects, summarizes, and deletes brews", () => {
    const bag = addBag();
    const first = repository.logBrew({
      bag_id: bag.id,
      drink_type: "espresso",
      timestamp: "2026-09-21T08:30:00-05:00",
      dose_g: 18,
      yield_g: 40,
      brew_time_seconds: 28,
      grind_setting: "4.3",
      rating: 3,
    });
    repository.logBrew({
      bag_id: bag.id,
      drink_type: "espresso",
      timestamp: "2026-09-22T08:30:00-05:00",
      dose_g: 18,
      yield_g: 36,
      brew_time_seconds: 30,
      rating: 5,
    });

    const corrected = repository.updateBrew(first.id, { rating: 4, notes: "Balanced", water_temp_c: null });
    expect(corrected).toMatchObject({ rating: 4, notes: "Balanced", brew_ratio: 2.22 });
    expect(repository.getBrewSummary({ bag_id: bag.id })).toMatchObject({
      brew_count: 2,
      average_dose_g: 18,
      average_yield_g: 38,
      average_rating: 4.5,
      best_rated_brew: { rating: 5 },
    });
    expect(repository.deleteBrew(first.id)).toEqual({ deleted: true, brew_id: first.id });
    expect(repository.getRecentBrews()).toHaveLength(1);
  });

  it("stores structured feedback and explicit inference provenance", () => {
    const bag = addBag();
    const brew = repository.logBrew({
      bag_id: bag.id,
      drink_type: "latte",
      dose_g: 18,
      yield_g: 36,
      taste_balance: "balanced",
      body_level: "good",
      milk_texture: "thick",
      art_rating: 3,
      provenance: {
        dose_g: { kind: "reported" },
        yield_g: { kind: "inferred", note: "Inherited from the prior recipe; please correct if different." },
      },
    });
    expect(brew).toMatchObject({
      taste_balance: "balanced",
      body_level: "good",
      milk_texture: "thick",
      art_rating: 3,
      provenance: { yield_g: { kind: "inferred" } },
    });
    expect(repository.getBrewSummary({ bag_id: bag.id })).toMatchObject({
      average_art_rating: 3,
      taste_counts: { balanced: 1 },
      milk_texture_counts: { thick: 1 },
      provenance_counts: { reported: 1, inferred: 1 },
    });
    expect(repository.updateBrew(brew.id, { milk_texture: "good", art_rating: 4 })).toMatchObject({
      milk_texture: "good",
      art_rating: 4,
    });
  });

  it("uses the configured timezone for date-only searches", () => {
    const bag = addBag();
    const localLate = repository.logBrew({
      bag_id: bag.id,
      drink_type: "espresso",
      timestamp: "2026-09-21T00:30:00-05:00",
    });
    repository.logBrew({
      bag_id: bag.id,
      drink_type: "espresso",
      timestamp: "2026-09-20T23:30:00-05:00",
    });
    expect(repository.searchBrews({ start_date: "2026-09-21", end_date: "2026-09-21" })
      .map(({ id }) => id)).toEqual([localLate.id]);
  });

  it("paginates brews with a stable cursor", () => {
    const bag = addBag();
    repository.logBrew({ bag_id: bag.id, drink_type: "espresso", timestamp: "2026-09-20T08:00:00Z" });
    const middle = repository.logBrew({ bag_id: bag.id, drink_type: "espresso", timestamp: "2026-09-21T08:00:00Z" });
    repository.logBrew({ bag_id: bag.id, drink_type: "espresso", timestamp: "2026-09-22T08:00:00Z" });
    expect(repository.getRecentBrews({ before_brew_id: middle.id }).map(({ timestamp }) => timestamp))
      .toEqual(["2026-09-20T08:00:00.000Z"]);
  });

  it("persists migrated records and selections across reconnect", () => {
    const bag = addBag();
    repository.setCurrentBean(bag.id, "filter");
    repository.logBrew({ bag_id: bag.id, drink_type: "pour_over" });
    repository.close();
    repository = new CoffeeRepository(databasePath, "America/Chicago");
    expect(repository.listCoffees()).toHaveLength(1);
    expect(repository.listBags()).toHaveLength(1);
    expect(repository.getCurrentBean("filter").bag?.id).toBe(bag.id);
    expect(repository.getRecentBrews()).toHaveLength(1);
  });

  it("rejects invalid references and measurements", () => {
    expect(() => repository.addBag({ coffee_id: 999 })).toThrow("unknown coffee ID");
    expect(() => repository.logBrew({ bag_id: 999, drink_type: "espresso" })).toThrow("unknown bag ID");
    const bag = addBag();
    expect(() => repository.logBrew({ bag_id: bag.id, drink_type: "espresso", dose_g: -1 }))
      .toThrow("greater than zero");
    expect(() => repository.logBrew({ bag_id: bag.id, drink_type: "espresso", rating: 6 }))
      .toThrow("1 to 5");
  });
});
