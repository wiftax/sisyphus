# Sisyphus

Rotates keys forever. Opens Notices of Assessment for [wif.tax](https://wif.tax).

wif.tax grades products on whether a machine can authenticate to them without
holding a long-lived static secret. Every grade on every card cites vendor
documentation: a URL, a date, and the exact sentence. Sisyphus is the crawler
that notices when those sentences move, and opens a pull request against
[wiftax/wiftax](https://github.com/wiftax/wiftax) proposing what the card
should say now, with receipts.

**Sisyphus does not merge. A human reads the receipts first.**

## What a patrol does

Every Monday at 09:00 UTC (and on demand), the `patrol` workflow:

1. Checks out `wiftax/wiftax` and reads every card in `data/products/`.
2. Fetches every unique evidence URL once. Polite: user agent
   `sisyphus/0.1 (+https://rotate.fail)`, one request per second per host,
   20 second timeout, redirects followed. HTML is reduced to visible text;
   strings embedded in JSON data islands (`__NEXT_DATA__` and friends) are
   mined as a secondary source, since some docs sites render tables client-side.
3. Decides, per URL, whether the documentation has drifted:
   - a `quote` the card cites no longer appears on the page, after
     normalization (whitespace, case, quote marks, dashes, table pipes, and a
     trailing sentence mark the card author may have dropped);
   - the URL errors or returns a non-2xx status;
   - for URLs with no quote, the visible text's hash differs from the one
     stored in `state/<card-id>.json` on the last patrol.
4. For each card with drift, calls Claude once (`claude-opus-5`, adaptive
   thinking, structured JSON output). The system prompt is `RUBRIC.md` plus
   `VOICE.md`. The user content is the current card and, for each drifted URL,
   the old quotes and up to 12,000 characters of the current page centred on
   the best fuzzy match. The model returns `{change_needed, proposed_card,
   rationale, vanished_quotes, new_quotes}` and may lower or raise grades, flip
   hygiene checks, or only refresh quotes and `checked_on`.
5. If a change is proposed: the YAML is written into the checkout and the
   repo's own `node scripts/validate.mjs` runs. Every new quote is checked
   programmatically against the fetched text. On failure the model is retried
   once with the errors; on a second failure an issue is opened instead of a
   PR. Touched evidence entries get `checked_on: <today>` and
   `checked_by: sisyphus`.
6. Opens a PR from branch `sisyphus/<card-id>-<YYYYMMDD>`, labelled `sisyphus`
   and `card:<card-id>`, unless an open PR with the card's label already
   exists. Title: `Notice of Assessment: <Vendor> <Product>` when the headline
   grade goes down or holds; `Notice of Relief: <Vendor> <Product>` when it
   goes up. The body lists before/after grades per surface, vanished quotes,
   new receipts with links, the rationale, and the fixed footer.
7. Commits `state/` back to this repo's `main` so hash comparison works next week.

## Running it locally

```sh
npm ci
# drift only, no model call, nothing written except out/
npx tsx src/cli.ts check --dry-run --no-llm --data ../wiftax
# one card, with the model, proposals written to out/ instead of git
npx tsx src/cli.ts check --dry-run --card github-api --data ../wiftax
```

Flags: `--card <id>` limits to one card; `--dry-run` prints what would happen
and writes proposed YAML and PR bodies to `out/` without touching git or
`state/`; `--no-llm` reports drift and skips assessment; `--data <path>` is a
wiftax checkout (default `./wiftax`); `--state <dir>` overrides the state
directory. Set `SISYPHUS_DUMP_DIR=/some/dir` to write every fetched page's
text to disk for debugging.

Locally the SDK resolves credentials the usual way (`ANTHROPIC_API_KEY`, an
`ant auth login` profile, or the federation variables below). In CI there is
no API key anywhere.

## Auth: zero static secrets, minus one

| Who Sisyphus talks to | How | Static secret |
|---|---|---|
| Anthropic | Workload Identity Federation: the job's GitHub OIDC token is exchanged for a short-lived Anthropic access token | none |
| GitHub | A GitHub App installation token minted at the start of each run, valid for one hour | the App's private key |

The GitHub App private key is the one static secret in the whole project.
GitHub Apps have no federated authentication path: the root of trust is a PEM
file that never expires. wif.tax grades GitHub's inbound surface C for exactly
this reason, and Sisyphus pays the same tax it assesses. When GitHub ships
federated App auth, this row goes away.

## Owner setup

Two things must be created by a human. Nothing else needs a login.

### 1. GitHub App

Create the App at <https://github.com/organizations/wiftax/settings/apps/new>:

| Field | Value |
|---|---|
| GitHub App name | `sisyphus` |
| Homepage URL | `https://rotate.fail` |
| Webhook | **Active** unchecked (no webhook) |
| Repository permissions | Contents: **Read and write**; Pull requests: **Read and write**; Issues: **Read and write**; Metadata: **Read-only** (added automatically) |
| Where can this GitHub App be installed? | Only on this account |

Then:

1. On the App's settings page, note the **App ID**.
2. Under **Private keys**, click **Generate a private key**. A `.pem` downloads.
3. **Install App** on the `wiftax` organization, selecting **Only select
   repositories**: `wiftax/wiftax` and `wiftax/sisyphus`. The App needs
   `wiftax` to push branches, open PRs and issues, and create labels; it needs
   `sisyphus` only to push the `state/` commit to `main`. (LAUNCH.md said
   `wiftax/wiftax` only; the state commit is why `sisyphus` is added. If you
   would rather not, install on `wiftax/wiftax` only and change the
   `Commit state` step to use `${{ github.token }}` with `contents: write`.)
4. In `wiftax/sisyphus` → Settings → Secrets and variables → Actions:
   - **Variable** `SISYPHUS_APP_ID` = the App ID (a number).
   - **Secret** `SISYPHUS_APP_PRIVATE_KEY` = the full contents of the `.pem`,
     including the `-----BEGIN RSA PRIVATE KEY-----` and `END` lines.

The workflow mints an installation token with
[`actions/create-github-app-token@v2`](https://github.com/actions/create-github-app-token)
scoped to those two repositories, and the code uses it through `gh` (`GH_TOKEN`).
PRs and commits appear as `sisyphus[bot]`.

### 2. Anthropic: Workload Identity Federation

Everything below is quoted from or matches the Anthropic docs:
[Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation),
[Use WIF with GitHub Actions](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions),
[WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference).

In the Claude Console, open **Settings → Workload identity**, click **Connect
workload**, and select the **GitHub Actions** tile. The wizard creates the
three resources. Use these values (they are the same whether you enter them in
the wizard or send them to the Admin API):

**Service account** (`svac_...`):

```json
{ "name": "sisyphus", "organization_role": "developer" }
```

**Federation issuer** (`fdis_...`). Per the GitHub Actions guide, GitHub
"publishes its OIDC discovery document and JWKS publicly, so use discovery mode":

```json
{
  "name": "github-actions",
  "issuer_url": "https://token.actions.githubusercontent.com",
  "jwks": { "type": "discovery" }
}
```

**Federation rule** (`fdrl_...`). The subject is pinned to this repository's
`main` branch so pull-request runs (including from forks) cannot mint a token.
The docs' GitHub Actions example includes `audience` and a `repository_owner`
claim, and warns: "A trailing wildcard such as `repo:my-org/my-repo:*` also
matches `pull_request` runs, including runs triggered from forks."

```json
{
  "name": "sisyphus-patrol",
  "issuer_id": "fdis_...",
  "match": {
    "subject_prefix": "repo:wiftax/sisyphus:ref:refs/heads/main",
    "audience": "https://api.anthropic.com",
    "claims": { "repository_owner": "wiftax" }
  },
  "target": { "type": "service_account", "service_account_id": "svac_..." },
  "workspace_id": "wrkspc_...",
  "oauth_scope": "workspace:inference",
  "token_lifetime_seconds": 3600
}
```

Notes on those fields, from the WIF reference:

- `subject_prefix` is "Exact match against the JWT `sub` claim. A trailing `*`
  makes it a prefix match." No wildcard here, so only `main` matches.
- `audience`: "The JWT `aud` claim must contain this exact string." The
  workflow requests the GitHub token with `audience=https://api.anthropic.com`,
  which is the value the docs use throughout.
- `oauth_scope: workspace:inference` grants "the inference endpoints in the
  rule's workspace: Messages (including streaming and token counting), Models".
  Sisyphus needs nothing else. Use `workspace:developer` if you later want
  Files or Skills.
- `token_lifetime_seconds` is 60 to 86400, default 3600. A patrol must finish
  within one Anthropic token lifetime: GitHub Actions identity tokens carry a
  `jti`, and "an assertion that carries a `jti` claim can be exchanged only
  once per issuer", so the SDK cannot re-exchange the same file on refresh.
  One hour is ample for a patrol of a dozen cards.
- `workspace_id`: the workspace whose quota and billing apply. If the rule is
  bound to a single workspace, `ANTHROPIC_WORKSPACE_ID` is optional and the
  workflow does not set it. If you enable the rule for more than one
  workspace, add `ANTHROPIC_WORKSPACE_ID` as a repository variable and to the
  workflow's `env`.

Then in `wiftax/sisyphus` → Settings → Secrets and variables → Actions →
**Variables** (none of these are secret):

| Variable | Value |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | the rule's ID, `fdrl_...` |
| `ANTHROPIC_ORGANIZATION_ID` | your organization's UUID, from Console **Settings → Organization** |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | the service account's ID, `svac_...` |

The workflow requests the OIDC token exactly as the GitHub Actions guide shows:

```sh
curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.anthropic.com" \
  | jq -r .value > "$ANTHROPIC_IDENTITY_TOKEN_FILE"
```

and sets `ANTHROPIC_IDENTITY_TOKEN_FILE` to that path. With the three
variables above also in the environment, `new Anthropic()` with no arguments
performs the exchange at `POST /v1/oauth/token` on the first request. The
identity token is fetched immediately before the run because "Each
GitHub-issued identity token expires roughly five minutes after issuance."

To verify: run the workflow by hand with `dry_run` checked. A denied exchange
is an opaque `401 Authentication failed`; the reason (for example
`match_subject_prefix`) is in the Console's authentication history at
**Settings → Workload identity → History**.

### Everything the owner sets, in one place

| Where | Kind | Name |
|---|---|---|
| `wiftax/sisyphus` Actions | Variable | `SISYPHUS_APP_ID` |
| `wiftax/sisyphus` Actions | **Secret** | `SISYPHUS_APP_PRIVATE_KEY` |
| `wiftax/sisyphus` Actions | Variable | `ANTHROPIC_FEDERATION_RULE_ID` |
| `wiftax/sisyphus` Actions | Variable | `ANTHROPIC_ORGANIZATION_ID` |
| `wiftax/sisyphus` Actions | Variable | `ANTHROPIC_SERVICE_ACCOUNT_ID` |
| `wiftax/sisyphus` Actions | Variable (optional) | `ANTHROPIC_WORKSPACE_ID`, only for multi-workspace rules |

## Layout

```
src/fetch.ts    polite fetching, HTML and Markdown to text, JSON data islands
src/drift.ts    card model, citation walk, normalization, drift detection, state
src/assess.ts   the one model call per card: prompts, schema, retry
src/pr.ts       validator, quote verification, stamping, PR/issue bodies, git + gh
src/cli.ts      `sisyphus check`
state/          one JSON per card: last hash and status per URL (committed by CI)
VOICE.md        how Sisyphus writes
.github/workflows/patrol.yml
```

## License

Apache-2.0.
