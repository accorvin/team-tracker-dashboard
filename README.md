# Team Tracker Dashboard

A dashboard for tracking GitHub issues and pull requests, with built-in awareness of Claude automations (issue triage, PR review verdicts, autofix attempts).

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url> && cd team-tracker-dashboard

# 2. Install dependencies
npm install

# 3. Configure your GitHub token
cp .env.example .env
# Edit .env with your real token

# 4. Start the server
npm start
# Visit http://localhost:3000
```

## Configuration

Create a `.env` file with:

```
GITHUB_TOKEN=ghp_your_token_here
GITHUB_REPO=red-hat-data-services/rhai-org-pulse
PORT=3000
```

- **GITHUB_TOKEN** — a GitHub Personal Access Token with `repo` scope ([create one here](https://github.com/settings/tokens/new?scopes=repo))
- **GITHUB_REPO** — the `owner/repo` to track
- **PORT** — server port (defaults to 3000)

## Features

- **Tabbed views** — separate tabs for Issues, Pull Requests, and Claude Activity
- **PR cards** — color-coded card view for pull requests:
  - **Green** — all checks passing
  - **Yellow** — needs rebase (branch is behind)
  - **Red** — merge conflicts, CI failure, or Claude review failure
- **Approve & Merge** — approve PRs directly from the dashboard, or merge approved PRs with one click. Your own PRs skip the approve step and show the merge button directly.
- **Stats bar** — at-a-glance counts for open issues, bugs, claimed items, open PRs, Claude fails, and changes requested
- **Filters** — filter issues and PRs by status, labels, Claude triage, review state, etc.
- **Server-side caching** — GitHub data is cached locally in JSON files. Page loads are instant; background refresh happens every 5 minutes.
- **Manual refresh** — hit the Refresh button to pull fresh data from GitHub on demand
- **Tab persistence** — your active tab is preserved across page refreshes via URL hash

## Architecture

- **`server.js`** — Node.js/Express backend that fetches GitHub data, caches it to `data/cache.json`, and proxies approve/merge actions
- **`index.html`** — single-file frontend (HTML + CSS + JS) served by the backend
- **`.env`** — GitHub token and repo configuration (not committed)

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve the dashboard |
| `GET` | `/api/data` | Return cached data (instant) |
| `POST` | `/api/refresh` | Trigger a fresh GitHub fetch |
| `POST` | `/api/prs/:number/approve` | Submit an approving review |
| `PUT` | `/api/prs/:number/merge` | Merge a pull request |

## Requirements

- Node.js 18+
- A GitHub PAT with `repo` scope
