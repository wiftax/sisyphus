# Sisyphus

Rotates keys forever. Opens Notices of Assessment for [wif.tax](https://wif.tax).

wif.tax grades products on whether a machine can authenticate to them without
holding a long-lived static secret. Every grade cites vendor documentation: a
URL, a date and the exact sentence. Sisyphus re-reads every cited page each
week. When a sentence has moved, it asks Claude what the card should say now
and opens a pull request against [wiftax/wiftax](https://github.com/wiftax/wiftax)
with the receipts.

**Sisyphus does not merge. A human reads the receipts first.**

The latest patrol is on [rotate.fail](https://rotate.fail).

## What a patrol does

The `patrol` workflow in
[wiftax/wiftax](https://github.com/wiftax/wiftax/blob/main/.github/workflows/patrol.yml)
runs every Monday at 09:00 UTC, and by hand.

1. **Fetch.** Every unique evidence URL across every card in `data/products/`
   is fetched once. The user agent is `sisyphus/0.2 (+https://rotate.fail)`.
   Each host gets at most one request per second, with a 20 second timeout.
   A 5xx, timeout or network error is retried once. HTML is reduced to visible
   text. Strings in embedded JSON (`__NEXT_DATA__` and similar) are read too,
   because some docs sites render tables in the browser.

2. **Compare.** For each URL:
   - **Quote vanished.** A quote the card cites is no longer on the page.
     Matching ignores case, whitespace, quote marks, dash styles, table pipes
     and a trailing full stop.
   - **Text changed.** The URL has no quote, and its text hash differs from
     last week's.
   - **Unreachable.** The fetch failed. This is not drift. It is classified as
     blocked (401, 403, 429), gone (404, 410), server error or network error.
     A page that answers but has no readable text, such as one rendered in the
     browser, counts as unreachable too ("empty"). The receipts are left alone
     and a streak counts consecutive failed patrols.

3. **Assess.** Each card with drift gets one call to Claude (`claude-opus-5-5`,
   adaptive thinking, effort `high`, structured JSON output). The system prompt
   is wiftax's `RUBRIC.md` plus [`VOICE.md`](VOICE.md). It is cached across
   cards. The user content is the card, the drifted URLs, and up to 12,000
   characters of each current page centred on the best match of the old
   quote. Calls for different cards run four at a time.

   A card is not assessed when a notice for it is already open, or when the
   card and its drift are exactly what Sisyphus assessed last time and the
   answer was "no change" or an issue.

4. **Check.** A proposed card must pass all of these. On failure the model
   gets one retry with the errors. After a second failure an issue is opened.
   - Every new quote appears verbatim on the fetched page for its URL.
   - Every receipt on a URL that did not drift is unchanged.
   - wiftax's own `scripts/validate.mjs` passes. It runs in a scratch copy,
     never in the checkout.

   Touched evidence gets `checked_on: <today>` and `checked_by: sisyphus`. The
   change is written into the original YAML in place, so the PR diff shows
   only the lines that moved.

5. **File.**
   - **Notice of Assessment** or **Notice of Relief**: one PR per card whose
     grades, tier gate, issuer list, status or hygiene results change. Relief
     when the headline grade goes up. Grade drops are filed first. At most 10
     per patrol (`--max-notices`); the rest wait for next week.
   - **Receipts refreshed**: one PR for every card whose quotes moved but whose
     grades held. Each patrol's refresh PR closes the previous one.
   - **Proposal rejected**: an issue, when a proposal fails its checks twice.
   - **Unreachable: \<host\>**: one issue per docs host whose pages have failed
     for two patrols in a row (`--unreachable-after`). It is updated each
     patrol and closed when the host answers again.

   Each PR is built in a temporary git worktree from `origin/main`, with the
   scoreboard re-rendered. A failure in one card cannot affect the next. If
   `gh pr create` fails after the push, the branch is deleted. GitHub calls
   retry on 5xx and network errors. PRs made with a workflow's `GITHUB_TOKEN`
   do not trigger other workflows, so Sisyphus starts the required `check`
   workflow on each branch itself. GitHub still creates a `pull_request` run
   for each such PR and holds it for approval. It would duplicate that check,
   so at the end of the patrol Sisyphus deletes held runs on `sisyphus/*`
   branches that `github-actions[bot]` started.

6. **Record.** Per-card state (page hashes, failure streaks, the last
   assessment) and `patrol.json` are committed to the `sisyphus-state` branch,
   even when the patrol fails partway. `patrol.json` holds the counts, the
   outcome for every card, the open PRs, the unreachable hosts, the model's
   token use and its cost at list price, and a year of weekly history.
   rotate.fail reads it from
   `raw.githubusercontent.com/wiftax/wiftax/sisyphus-state/patrol.json`.

## Running it locally

```sh
npm ci
npm test

# drift only, no model, nothing written outside out/
npx tsx src/cli.ts check --dry-run --no-llm --data ../wiftax

# one card with the model; the proposal and PR body go to out/
npx tsx src/cli.ts check --dry-run --card github-api --data ../wiftax
```

| Flag | Default | |
|---|---|---|
| `--data <path>` | `./wiftax` or `$WIFTAX_DIR` | a wiftax checkout with `npm ci` done |
| `--state <dir>` | `./state` | per-card state and `patrol.json` |
| `--out <dir>` | `./out` | dry-run output |
| `--card <id>` | all | one card. Its report goes to `out/`, not the state branch |
| `--dry-run` | off | write proposals, PR bodies and issues to `out/`. No git, no GitHub, no state |
| `--no-llm` | off | report drift and skip the model |
| `--max-notices <n>` | 10 | most notices per patrol |
| `--concurrency <n>` | 4 | model calls in flight |
| `--unreachable-after <n>` | 2 | patrols a URL must fail before its host gets an issue |

| Environment | |
|---|---|
| `SISYPHUS_MODEL`, `SISYPHUS_EFFORT` | override `claude-opus-5-5` and `high` |
| `SISYPHUS_DUMP_DIR` | write every fetched page's text here |
| `SISYPHUS_UPSTREAM` | the repo PRs go to, default `wiftax/wiftax` |
| `SISYPHUS_CHECK_WORKFLOW` | workflow to start on each PR branch |

Locally the SDK finds credentials the usual way: `ANTHROPIC_API_KEY`, an
`ant auth login` profile, or the federation variables below. CI has no API key.

## Auth: zero static secrets

| Who Sisyphus talks to | How | Static secret |
|---|---|---|
| Anthropic | Workload Identity Federation. The job's GitHub OIDC token is exchanged for a short-lived Anthropic access token | none |
| GitHub | The `GITHUB_TOKEN` of the `wiftax/wiftax` workflow run, valid for one job | none |

Sisyphus used to run in this repo as a GitHub App, whose private key was the
project's one static secret. GitHub Apps have no federated authentication, so
the patrol moved into `wiftax/wiftax`, the only repo it writes to. The App and
its key are deleted. This repo holds code, tests and a CI workflow with
read-only permissions. It has no secrets.

## Owner setup

### GitHub

In `wiftax/wiftax`:

- `.github/workflows/patrol.yml` needs `contents`, `pull-requests`, `issues`
  and `actions` write, and `id-token` write.
- Settings → Actions → General → **Allow GitHub Actions to create and approve
  pull requests** is on, and allowed by the `wiftax` organization. The `main`
  ruleset still requires a code-owner review, so nothing merges itself.
- The `sisyphus-state` branch is outside the `main` ruleset.
- `check.yml` accepts `workflow_dispatch`.

### Anthropic: Workload Identity Federation

From the Anthropic docs:
[Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation),
[WIF with GitHub Actions](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions),
[WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference).

In the Claude Console, open **Settings → Workload identity → Connect
workload → GitHub Actions**. The wizard creates three resources:

**Service account** (`svac_...`):

```json
{ "name": "sisyphus", "organization_role": "developer" }
```

**Federation issuer** (`fdis_...`). GitHub publishes its discovery document
and JWKS, so use discovery mode:

```json
{
  "name": "github-actions",
  "issuer_url": "https://token.actions.githubusercontent.com",
  "jwks": { "type": "discovery" }
}
```

**Federation rule** (`fdrl_...`). The subject is pinned to `main` of
`wiftax/wiftax`, so pull request runs, including runs from forks, cannot mint
a token:

```json
{
  "name": "sisyphus-patrol",
  "issuer_id": "fdis_...",
  "match": {
    "subject_prefix": "repo:wiftax@330212943/wiftax@1373787774:ref:refs/heads/main",
    "audience": "https://api.anthropic.com",
    "claims": { "repository_owner": "wiftax" }
  },
  "target": { "type": "service_account", "service_account_id": "svac_..." },
  "workspace_id": "wrkspc_...",
  "oauth_scope": "workspace:inference",
  "token_lifetime_seconds": 3600
}
```

Notes:

- **Subject format.** GitHub's OIDC `sub` claim now carries numeric IDs:
  `repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/main`. The Console
  wizard pre-fills the old `repo:<owner>/<repo>:...` form, which is denied
  with `match_subject_prefix`. Copy the exact `sub` from **Settings → Workload
  identity → Authentication events**.
- `subject_prefix` without a trailing `*` is an exact match, so only `main`
  matches. A trailing `*` would also match `pull_request` runs.
- `workspace:inference` covers Messages, token counting and Models, which is
  all Sisyphus uses.
- A patrol takes longer than one GitHub identity token lives (about five
  minutes) and can take longer than one Anthropic token lives. Each GitHub
  token can be exchanged only once. So before each model call,
  `src/assess.ts` writes a fresh GitHub token into
  `ANTHROPIC_IDENTITY_TOKEN_FILE`, at most once every three minutes, and the
  SDK reads that file whenever it re-exchanges. Concurrent calls share one
  Anthropic token.
- If the rule covers more than one workspace, set `ANTHROPIC_WORKSPACE_ID`.

Then set these **repository variables** (not secrets) in `wiftax/wiftax` →
Settings → Secrets and variables → Actions:

| Variable | Value |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | `fdrl_...` |
| `ANTHROPIC_ORGANIZATION_ID` | organization UUID, from Console **Settings → Organization** |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | `svac_...` |
| `ANTHROPIC_WORKSPACE_ID` | optional, only for multi-workspace rules |

To verify, run the patrol workflow by hand with `dry_run` checked. It makes a
free `count_tokens` call. A denied exchange is an opaque `401 Authentication
failed`. The reason is in the Console under **Settings → Workload identity →
History**.

## Layout

```
src/fetch.ts      polite fetching, HTML and Markdown to text, failure kinds
src/drift.ts      card model, citations, matching, drift and unreachable URLs, state
src/assess.ts     the model call: prompts, schema, retry, identity token refresh
src/yamlpatch.ts  write a proposal into the original YAML, changing only what moved
src/pr.ts         checks on a proposal, PR and issue bodies, worktree publishing
src/report.ts     patrol.json
src/run.ts        git and gh, with retries for gh
src/cli.ts        sisyphus check
test/             node:test, with a fixture checkout, a local docs server and a gh stub
VOICE.md          how Sisyphus writes
```

## License

Apache-2.0.
