# Coffee Tracker

Coffee Tracker is a local-first coffee journal for OpenClaw. It stores reusable coffee identities, physical bags, current espresso/filter selections, and individual brews in SQLite. Natural-language interpretation remains the agent's job; the plugin provides deterministic storage, correction, search, pagination, and summaries.

## Data model

- **Coffee** — reusable identity: roaster, name, origin, process, notes.
- **Bag** — one purchase of a coffee: roast/open/finish dates, original size, notes.
- **Brew** — one preparation tied to a physical bag.

`coffee_add_bean` remains a convenience tool that creates a coffee and its first bag together. Existing v1 databases migrate automatically: each legacy bean becomes one coffee and one bag, with existing brews and current selections preserved.

The database is stored at:

```text
<OpenClaw state directory>/plugins/coffee-tracker/coffee-tracker.sqlite
```

## Tools

### Coffee and bag management

- `coffee_add_bean` — create a coffee and its first bag together
- `coffee_add_coffee` — create a reusable coffee identity
- `coffee_add_bag` — add another physical bag for an existing coffee
- `coffee_list_coffees` / `coffee_list_bags` — cursor-paginated listings
- `coffee_update_coffee` / `coffee_update_bag` — correct metadata; marking `finished_date` closes a bag
- `coffee_list_beans` — compatibility alias that lists active bags

### Current selection and brewing

- `coffee_set_current_bean` / `coffee_get_current_bean` — set or read the current physical bag by context
- `coffee_unset_current_bean` — clear a context selection
- `coffee_log_brew` — record a brew by bag or current context
- `coffee_update_brew` — correct measurements, timestamp, bag, rating, or notes
- `coffee_delete_brew` — delete a mistaken brew with explicit confirmation
- `coffee_get_recent_brews` / `coffee_search_brews` — query history with cursor pagination
- `coffee_get_brew_summary` — deterministic averages and best-rated brew

Ratings are integers from 1–5. Measurements must be positive. Optional update fields accept `null` to clear them.

## Timezone behavior

Timestamps are stored in UTC. Date-only search boundaries such as `2026-10-12` are interpreted as a calendar day in the configured IANA timezone:

```yaml
plugins:
  entries:
    coffee-tracker:
      config:
        timezone: America/Chicago
```

If omitted, the host's resolved timezone is used.

## Development

```bash
npm install
npm test
npm run plugin:build
npm run plugin:validate
```

Tests use isolated temporary SQLite databases and do not access the live journal.

For linked local development:

```bash
openclaw plugins install --link .
openclaw plugins reload coffee-tracker
```

## License

[MIT](LICENSE) © 2026 Derek Gliwa
