const express = require('express');
const fs = require('fs');
const path = require('path');

// Load .env manually (no dotenv dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const CLAUDE_BOTS = [
  'github-actions[bot]',
  'claude-issue-assistant[bot]',
  'anthropic-claude[bot]',
  'claude[bot]',
];

if (!GITHUB_TOKEN || GITHUB_TOKEN === 'ghp_your_token_here') {
  console.error('Set GITHUB_TOKEN in .env');
  process.exit(1);
}
if (!GITHUB_REPO) {
  console.error('Set GITHUB_REPO in .env');
  process.exit(1);
}

let authenticatedUser = null;

async function fetchAuthenticatedUser() {
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (resp.ok) {
      const data = await resp.json();
      authenticatedUser = data.login;
      console.log(`[auth] Authenticated as ${authenticatedUser}`);
    }
  } catch (err) {
    console.error('[auth] Failed to fetch user:', err.message);
  }
}

// ---- GitHub API helpers ----

async function ghFetch(apiPath) {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

async function ghFetchAll(apiPath, maxPages = 5) {
  let results = [];
  let page = 1;
  while (page <= maxPages) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const data = await ghFetch(`${apiPath}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ---- Claude detection ----

function isClaudeBot(login) {
  return CLAUDE_BOTS.some(b => login.toLowerCase() === b.toLowerCase()) ||
    login.toLowerCase().includes('claude');
}

function getClaudeReviewStatus(checks) {
  const claudeChecks = checks.filter(c =>
    c.name === 'Claude Review' || c.name === 'Claude Review (Fork)'
  );
  if (claudeChecks.length === 0) return { status: 'none', label: '\u2014' };

  const substantive = claudeChecks.filter(c => c.conclusion !== 'skipped' && c.conclusion !== null);
  if (substantive.length === 0) {
    const pending = claudeChecks.filter(c => c.status !== 'completed');
    if (pending.length > 0) return { status: 'pending', label: 'Pending' };
    return { status: 'skipped', label: 'Skipped' };
  }

  for (const check of substantive) {
    const text = (check.output?.text || '') + (check.output?.summary || '');
    if (/"verdict"\s*:\s*"FAIL"/i.test(text) || /verdict.*FAIL/i.test(text)) {
      return { status: 'fail', label: 'FAIL' };
    }
  }

  if (substantive.every(c => c.conclusion === 'success')) return { status: 'pass', label: 'PASS' };
  if (substantive.some(c => c.conclusion === 'failure')) return { status: 'fail', label: 'FAIL' };
  return { status: 'pending', label: 'Running' };
}

function getCIStatus(checks) {
  const ciCheck = checks.find(c => c.name === 'Test & Build');
  if (!ciCheck) return { status: 'none', label: '\u2014' };
  if (ciCheck.status !== 'completed') return { status: 'pending', label: 'Running' };
  if (ciCheck.conclusion === 'success') return { status: 'pass', label: 'Pass' };
  return { status: 'fail', label: 'Fail' };
}

function getReviewDecision(reviews) {
  if (!reviews || reviews.length === 0) return { status: 'pending', label: 'Pending' };
  const latestByUser = {};
  for (const r of reviews) {
    if (isClaudeBot(r.user.login)) continue;
    if (r.state === 'COMMENTED') continue;
    latestByUser[r.user.login] = r;
  }
  const latest = Object.values(latestByUser);
  if (latest.length === 0) return { status: 'pending', label: 'Pending' };
  if (latest.some(r => r.state === 'CHANGES_REQUESTED')) return { status: 'changes', label: 'Changes requested' };
  if (latest.every(r => r.state === 'APPROVED')) return { status: 'approved', label: 'Approved' };
  return { status: 'pending', label: 'In review' };
}

// ---- Full data fetch ----

let refreshInProgress = false;

async function fetchAllData() {
  if (refreshInProgress) return readCache();
  refreshInProgress = true;
  console.log('[refresh] Fetching data from GitHub...');
  const startTime = Date.now();

  try {
    // Fetch issues and PRs
    const [rawIssues, prs] = await Promise.all([
      ghFetchAll('/issues?state=open&sort=updated&direction=desc'),
      ghFetchAll('/pulls?state=open&sort=updated&direction=desc'),
    ]);
    const issues = rawIssues.filter(i => !i.pull_request);

    // Issue claude triage status
    const issueClaudeStatus = {};
    await Promise.all(issues.map(async (issue) => {
      try {
        const comments = await ghFetchAll(`/issues/${issue.number}/comments`);
        if (comments.find(c => isClaudeBot(c.user.login))) {
          issueClaudeStatus[issue.number] = true;
        }
      } catch {}
    }));

    // PR details: checks, reviews, merge status
    const prClaudeStatus = {};
    const prCIStatus = {};
    const prReviewStatus = {};
    const prMergeStatus = {};

    await Promise.all(prs.map(async (pr) => {
      try {
        const [checks, reviews, prDetail] = await Promise.all([
          ghFetch(`/commits/${pr.head.sha}/check-runs?per_page=100`).then(d => d.check_runs || []).catch(() => []),
          ghFetchAll(`/pulls/${pr.number}/reviews`).catch(() => []),
          ghFetch(`/pulls/${pr.number}`).catch(() => null),
        ]);
        prClaudeStatus[pr.number] = getClaudeReviewStatus(checks);
        prCIStatus[pr.number] = getCIStatus(checks);
        prReviewStatus[pr.number] = getReviewDecision(reviews);
        if (prDetail) {
          const ms = prDetail.mergeable_state;
          if (prDetail.mergeable === false || ms === 'dirty') {
            prMergeStatus[pr.number] = 'conflicts';
          } else if (ms === 'behind') {
            prMergeStatus[pr.number] = 'behind';
          } else {
            prMergeStatus[pr.number] = 'clean';
          }
        }
      } catch {}
    }));

    // Activity feed
    const activity = [];

    // Claude issue comments
    for (const issue of issues) {
      if (!issueClaudeStatus[issue.number]) continue;
      try {
        const comments = await ghFetchAll(`/issues/${issue.number}/comments`);
        for (const c of comments) {
          if (!isClaudeBot(c.user.login)) continue;
          const body = c.body.length > 120 ? c.body.slice(0, 120) + '\u2026' : c.body;
          activity.push({
            icon: '\uD83D\uDCAC',
            text: `Triaged #${issue.number}`,
            body,
            issueNumber: issue.number,
            date: c.created_at,
          });
        }
      } catch {}
    }

    // Claude PR reviews
    for (const pr of prs) {
      const cs = prClaudeStatus[pr.number];
      if (cs && cs.status !== 'none' && cs.status !== 'skipped') {
        activity.push({
          icon: cs.status === 'pass' ? '\u2705' : cs.status === 'fail' ? '\u274C' : '\u23F3',
          text: `Reviewed #${pr.number} \u2014 ${cs.label}`,
          prNumber: pr.number,
          date: pr.updated_at,
        });
      }
      try {
        const commits = await ghFetchAll(`/pulls/${pr.number}/commits`);
        for (const c of commits) {
          const authorName = (c.commit?.author?.name || '').toLowerCase();
          if (authorName.includes('claude') || authorName.includes('github-actions')) {
            if (c.commit.message.toLowerCase().includes('fix') || c.commit.message.toLowerCase().includes('autofix')) {
              activity.push({
                icon: '\uD83D\uDD27',
                text: `Autofix on #${pr.number}`,
                body: c.commit.message.split('\n')[0],
                prNumber: pr.number,
                date: c.commit.author.date,
              });
            }
          }
        }
      } catch {}
    }

    // Claude-opened PRs
    try {
      const recentPRs = await ghFetchAll('/pulls?state=all&sort=created&direction=desc&per_page=30');
      for (const pr of recentPRs) {
        if (isClaudeBot(pr.user.login)) {
          activity.push({
            icon: '\uD83D\uDE80',
            text: `Opened PR #${pr.number} \u2014 ${pr.title}`,
            prNumber: pr.number,
            date: pr.created_at,
          });
        }
      }
    } catch {}

    // Sort and dedupe
    activity.sort((a, b) => new Date(b.date) - new Date(a.date));
    const seen = new Set();
    const dedupedActivity = activity.filter(a => {
      if (seen.has(a.text)) return false;
      seen.add(a.text);
      return true;
    });

    const cache = {
      issues,
      prs,
      issueClaudeStatus,
      prClaudeStatus,
      prCIStatus,
      prReviewStatus,
      prMergeStatus,
      activity: dedupedActivity,
      repo: GITHUB_REPO,
      currentUser: authenticatedUser,
      lastUpdated: new Date().toISOString(),
    };

    writeCache(cache);
    console.log(`[refresh] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s — ${issues.length} issues, ${prs.length} PRs`);
    return cache;
  } catch (err) {
    console.error('[refresh] Error:', err.message);
    return readCache();
  } finally {
    refreshInProgress = false;
  }
}

// ---- Cache I/O ----

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// ---- Express app ----

const app = express();
app.use(express.json());

// Serve index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Get cached data (instant)
app.get('/api/data', (_req, res) => {
  const cache = readCache();
  if (cache) {
    res.json(cache);
  } else {
    res.json({ issues: [], prs: [], activity: [], repo: GITHUB_REPO, currentUser: authenticatedUser, lastUpdated: null });
  }
});

// Trigger manual refresh
app.post('/api/refresh', async (_req, res) => {
  try {
    const data = await fetchAllData();
    res.json(data || { error: 'No data available' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve a PR
app.post('/api/prs/:number/approve', async (req, res) => {
  try {
    const prNum = req.params.number;
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/pulls/${prNum}/reviews`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event: 'APPROVE' }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ error: err.message || `GitHub ${resp.status}` });
    }
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Merge a PR
app.put('/api/prs/:number/merge', async (req, res) => {
  try {
    const prNum = req.params.number;
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/pulls/${prNum}/merge`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ merge_method: 'merge' }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ error: err.message || `GitHub ${resp.status}` });
    }
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Start ----

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  // Fetch authenticated user, then initial data
  fetchAuthenticatedUser().then(() => {
    const cache = readCache();
    const age = cache?.lastUpdated ? Date.now() - new Date(cache.lastUpdated).getTime() : Infinity;
    if (age < REFRESH_INTERVAL_MS) {
      console.log(`[startup] Cache is ${(age / 1000).toFixed(0)}s old, skipping fetch`);
    } else {
      fetchAllData();
    }
  });
  // Background refresh
  setInterval(fetchAllData, REFRESH_INTERVAL_MS);
});
