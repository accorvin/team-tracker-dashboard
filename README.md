# Team Tracker Dashboard

A single-page dashboard for tracking GitHub issues and pull requests, with built-in awareness of Claude automations (issue triage, PR review verdicts, autofix attempts).

![Dark theme, auto-refreshing dashboard](https://img.shields.io/badge/theme-dark-0d1117)

## Quick Start

Just open `index.html` in your browser:

```bash
# Option 1: open directly
open index.html        # macOS
xdg-open index.html    # Linux

# Option 2: serve locally (avoids any file:// quirks)
python3 -m http.server 8090
# then visit http://localhost:8090
```

On first load, you'll be prompted to enter:

1. **GitHub Personal Access Token** — needs `repo` scope ([create one here](https://github.com/settings/tokens/new?scopes=repo))
2. **Repository** — defaults to `red-hat-data-services/rhai-org-pulse`, but you can point it at any repo

Your token is stored in `localStorage` — it never leaves your browser.

## Features

- **Issues view** — open issues with labels, author, age, and whether Claude has triaged them
- **PRs view** — open PRs with CI status, Claude review verdict (PASS/FAIL/pending), review decisions, and autofix status
- **Stats bar** — at-a-glance counts for open issues, bugs, claimed items, open PRs, Claude fails, and changes requested
- **Auto-refresh** — data refreshes every 5 minutes
- **Direct links** — every item links to its GitHub page

## Requirements

- A modern browser (Chrome, Firefox, Safari, Edge)
- A GitHub PAT with `repo` scope

No build step, no dependencies, no server required.
