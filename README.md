# Coffee Tracker

Coffee Tracker is a local-first, persistent coffee and espresso journal for OpenClaw. It gives agents typed tools for recording beans, selecting current espresso/filter beans, logging brews, and querying brew history. Natural-language interpretation remains the OpenClaw agent's job; this plugin only performs deterministic storage and retrieval.

## Data storage

Coffee Tracker owns a SQLite database at:

```text
<OpenClaw state directory>/plugins/coffee-tracker/coffee-tracker.sqlite
```

For the default profile this is usually:

```text
~/.openclaw/plugins/coffee-tracker/coffee-tracker.sqlite
```

`OPENCLAW_STATE_DIR` and named OpenClaw profiles change the state-directory prefix. The schema is explicitly versioned, SQLite foreign keys are enabled, and the database persists independently of conversations, sessions, and models.

## Tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `coffee_add_bean` | Create a bean/bag | Required: `roaster`, `name`. Optional: `origin`, `process`, `roast_date`, `opened_date`, `notes` |
| `coffee_list_beans` | List beans (default limit 20) | Optional: `context` (`espresso` or `filter`), `limit` (1–100) |
| `coffee_set_current_bean` | Set one current bean for a brew context | Required: `bean_id`, `context` |
| `coffee_get_current_bean` | Read the current bean or an explicit unconfigured result | Required: `context` |
| `coffee_log_brew` | Record a brew using an explicit bean or a context's current bean | Required: `drink_type`; either `bean_id` or `context`. Optional: `timestamp`, `dose_g`, `yield_g`, `water_g`, `grind_setting`, `grinder`, `brew_time_seconds`, `water_temp_c`, `rating`, `notes` |
| `coffee_get_recent_brews` | Return newest brews (default limit 5) with bean details | Optional: `bean_id`, `context`, `drink_type`, `limit` |
| `coffee_search_brews` | Structured historical search (default limit 10) | Optional: `bean_id`, `drink_type`, `start_date`, `end_date`, `minimum_rating`, `limit` |

Dates use `YYYY-MM-DD`; timestamps use ISO 8601. Ratings are integers from 1 to 5. Measurements and brew times must be greater than zero. Supported v1 drink types are `espresso`, `americano`, `cortado`, `cappuccino`, `latte`, `pour_over`, `drip`, `aeropress`, and `other`. Grind settings are strings so values such as `4.3` and `12 clicks` retain their grinder-specific representation.

OpenClaw tool names must match `^[a-zA-Z0-9_-]+$`, so the public names use underscores rather than dotted namespaces. If both `dose_g` and `yield_g` exist, brew results include a derived `brew_ratio`; it is not persisted.

## Development

Requires Node 24.16+ or Node 26.1+ and a compatible OpenClaw installation.

```bash
npm install
npm run build             # Type-check and compile
npm test                  # Isolated temporary SQLite integration tests
npm run plugin:build      # Compile and refresh generated plugin metadata
npm run plugin:validate   # Compile and validate against OpenClaw
```

The project scaffold does not configure a separate lint command.

Tests create databases under the operating system temporary directory and never access the real Coffee Tracker database.

## Install and reload

For linked local development:

```bash
npm install
npm run plugin:build
npm run plugin:validate
openclaw plugins install --link .
openclaw plugins inspect coffee-tracker --runtime
```

After making and building changes:

```bash
npm run plugin:build
openclaw plugins reload coffee-tracker
```

If a copy of the plugin is already installed rather than linked, reinstall it with `openclaw plugins install --force .` before reloading.

## Example OpenClaw interactions

The agent should translate requests like these into calls to the tools above:

- "I opened a bag of Onyx Geometry today."
- "Make it my current espresso bean."
- "Log an espresso: 18g in, 40g out, 29 seconds, grind 4.3, rating 4, slightly sour."
- "What were my last five shots with this bean?"
- "What grind setting have I been using?"
- "What were my best shots with this coffee?"

Coffee Tracker intentionally provides no dialing rules, recommendations, embeddings, semantic search, external APIs, or conversational layer.
