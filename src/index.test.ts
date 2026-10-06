import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { CoffeeRepository } from "./repository.js";

const TOOL_NAMES = [
  "coffee_add_bean",
  "coffee_list_beans",
  "coffee_set_current_bean",
  "coffee_get_current_bean",
  "coffee_log_brew",
  "coffee_get_recent_brews",
  "coffee_search_brews",
];

describe("coffee-tracker metadata", () => {
  it("declares the Coffee Tracker tools", () => {
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
    repository = new CoffeeRepository(databasePath);
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const addBean = (name = "Geometry") => repository.addBean({
    roaster: "Onyx",
    name,
    origin: "Ethiopia",
    opened_date: "2026-09-20",
  });

  it("creates and returns a bean", () => {
    const bean = addBean();
    expect(bean).toMatchObject({ id: 1, roaster: "Onyx", name: "Geometry", origin: "Ethiopia" });
    expect(bean.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("lists beans newest first with a bounded limit", () => {
    addBean("First");
    addBean("Second");
    expect(repository.listBeans({ limit: 1 }).map((bean) => bean.name)).toEqual(["Second"]);
  });

  it("sets and gets the current espresso bean", () => {
    const bean = addBean();
    expect(repository.setCurrentBean(bean.id, "espresso")).toEqual({ context: "espresso", bean });
    expect(repository.getCurrentBean("espresso")).toEqual({ context: "espresso", configured: true, bean });
    expect(repository.listBeans({ context: "espresso" })).toEqual([bean]);
  });

  it("sets and gets the current filter bean independently", () => {
    const espresso = addBean("Espresso");
    const filter = addBean("Filter");
    repository.setCurrentBean(espresso.id, "espresso");
    repository.setCurrentBean(filter.id, "filter");
    expect(repository.getCurrentBean("filter").bean?.id).toBe(filter.id);
    expect(repository.getCurrentBean("espresso").bean?.id).toBe(espresso.id);
  });

  it("logs a brew with an explicit bean and derives espresso ratio", () => {
    const bean = addBean();
    const brew = repository.logBrew({
      bean_id: bean.id,
      timestamp: "2026-09-21T08:30:00Z",
      drink_type: "espresso",
      dose_g: 18,
      yield_g: 40,
      grind_setting: "4.3",
      rating: 4,
    });
    expect(brew).toMatchObject({ bean_id: bean.id, grind_setting: "4.3", brew_ratio: 2.22 });
    expect(brew.bean).toMatchObject({ id: bean.id, name: "Geometry" });
  });

  it("logs a brew using the current bean", () => {
    const bean = addBean();
    repository.setCurrentBean(bean.id, "espresso");
    expect(repository.logBrew({ context: "espresso", drink_type: "espresso" }).bean_id).toBe(bean.id);
  });

  it("retrieves recent brews newest first and includes bean details", () => {
    const bean = addBean();
    repository.logBrew({ bean_id: bean.id, drink_type: "espresso", timestamp: "2026-09-20T08:00:00Z" });
    repository.logBrew({ bean_id: bean.id, drink_type: "espresso", timestamp: "2026-09-21T08:00:00Z" });
    const brews = repository.getRecentBrews({ bean_id: bean.id, limit: 1 });
    expect(brews).toHaveLength(1);
    expect(brews[0]?.timestamp).toBe("2026-09-21T08:00:00.000Z");
    expect(brews[0]?.bean.name).toBe("Geometry");
  });

  it("filters brew history by bean, drink type, date, and rating", () => {
    const selected = addBean("Selected");
    const other = addBean("Other");
    repository.logBrew({ bean_id: selected.id, drink_type: "espresso", timestamp: "2026-09-20T08:00:00Z", rating: 3 });
    const expected = repository.logBrew({ bean_id: selected.id, drink_type: "espresso", timestamp: "2026-09-21T08:00:00Z", rating: 5 });
    repository.logBrew({ bean_id: selected.id, drink_type: "pour_over", timestamp: "2026-09-21T09:00:00Z", rating: 5 });
    repository.logBrew({ bean_id: other.id, drink_type: "espresso", timestamp: "2026-09-21T10:00:00Z", rating: 5 });

    expect(repository.searchBrews({
      bean_id: selected.id,
      drink_type: "espresso",
      start_date: "2026-09-21",
      end_date: "2026-09-21",
      minimum_rating: 4,
    }).map((brew) => brew.id)).toEqual([expected.id]);
  });

  it("persists records and current selections across reconnection", () => {
    const bean = addBean();
    repository.setCurrentBean(bean.id, "filter");
    repository.logBrew({ bean_id: bean.id, drink_type: "pour_over" });
    repository.close();

    repository = new CoffeeRepository(databasePath);
    expect(repository.listBeans()).toHaveLength(1);
    expect(repository.getCurrentBean("filter").bean?.id).toBe(bean.id);
    expect(repository.getRecentBrews()).toHaveLength(1);
  });

  it("rejects invalid bean references", () => {
    expect(() => repository.setCurrentBean(999, "espresso")).toThrow("unknown bean ID: 999");
    expect(() => repository.logBrew({ bean_id: 999, drink_type: "espresso" })).toThrow("unknown bean ID: 999");
  });

  it("returns none for an unset current bean and rejects resolution through it", () => {
    expect(repository.getCurrentBean("espresso")).toEqual({ context: "espresso", configured: false, bean: null });
    expect(() => repository.logBrew({ context: "espresso", drink_type: "espresso" })).toThrow(
      "no current espresso bean configured",
    );
  });

  it("validates required text, dates, positive measurements, ratings, and missing bean selection", () => {
    expect(() => repository.addBean({ roaster: " ", name: "Coffee" })).toThrow("roaster must not be blank");
    expect(() => repository.addBean({ roaster: "Onyx", name: "Coffee", roast_date: "2026-02-30" })).toThrow(
      "roast_date is not a valid calendar date",
    );
    const bean = addBean();
    expect(() => repository.logBrew({ bean_id: bean.id, drink_type: "espresso", dose_g: -1 })).toThrow(
      "dose_g must be greater than zero",
    );
    expect(() => repository.logBrew({ bean_id: bean.id, drink_type: "espresso", rating: 6 })).toThrow(
      "rating must be an integer from 1 to 5",
    );
    expect(() => repository.logBrew({ drink_type: "espresso" })).toThrow("bean_id is required");
  });
});
