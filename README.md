# Coffee Tracker

Coffee Tracker is a local-first coffee journal for OpenClaw. It stores reusable coffee identities, physical bags, current espresso/filter selections, individual brews, and brew photos. Natural-language interpretation remains the agent's job; the plugin provides deterministic storage, correction, search, pagination, and summaries.

## Data model

- **Coffee** — reusable identity: roaster, name, origin, process, notes.
- **Bag** — one purchase of a coffee: roast/open/finish dates, original size, notes.
- **Brew** — one preparation tied to a physical bag.
- **Brew photo** — one managed image and thumbnail tied to a brew.

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
- `coffee_delete_brew` — delete a mistaken brew with explicit confirmation; attached photos must be removed first
- `coffee_photo_add` — attach a staged local JPEG, PNG, or WebP image to a brew
- `coffee_photo_list` — list photos, optionally for one brew, with managed image and thumbnail paths
- `coffee_photo_update` — correct a caption or capture timestamp
- `coffee_photo_delete` — permanently remove a managed image, thumbnail, and metadata with explicit confirmation
- `coffee_get_recent_brews` / `coffee_search_brews` — query history with cursor pagination
- `coffee_get_brew_summary` — deterministic averages and best-rated brew

Ratings are integers from 1–5. Measurements must be positive. Optional update fields accept `null` to clear them.

## Photo storage

Photo metadata and brew relationships are stored in SQLite. Managed files live beside the database:

```text
<OpenClaw state directory>/plugins/coffee-tracker/
├── coffee-tracker.sqlite
└── photos/YYYY/MM/
    ├── <photo-id>.jpg|png|webp
    └── <photo-id>-thumb.webp
```

`coffee_photo_add` accepts an existing local attachment path up to 25 MB. It validates the file as JPEG, PNG, or WebP, applies encoded orientation, re-encodes the managed image without EXIF metadata, creates a maximum 512×512 WebP thumbnail, and stores files with restrictive permissions. The source upload is not modified or deleted.

Photo records retain the original filename, MIME type, dimensions, byte size, SHA-256 digest, caption, and capture timestamp. Capture time defaults to the brew timestamp. Backups should include both `coffee-tracker.sqlite` and the `photos/` directory.

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
