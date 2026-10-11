# Runbook: `ep00-start`

Everything you need to run this branch, what each command does, and what you should see.
Every command below was run on a clean checkout before this runbook was written.

## 1. What this branch is

`ep00-start` is the baseline of the series: a small food-delivery backend with login, restaurants,
orders and a charge through a fake payment provider. It also holds one structured LLM call (the "probe")
that proves the model provider is reachable.

What you will see when it runs:

| You will see | Where |
|---|---|
| A REST API with login, token refresh, restaurants, orders and payment | `http://localhost:3000` |
| A fake payment provider you can make succeed, decline, time out or fail on demand | `http://localhost:4010` |
| One request traced across both processes | Jaeger at `http://localhost:16686` |
| 41 passing tests (33 API + 8 fake provider) | `pnpm test` |
| One typed answer from a language model | `pnpm probe:llm` |

What is **not** in this branch, on purpose: chat, tools, RAG, the agent loop, refunds. Those arrive in later episode branches.

## 2. Prerequisites

| Need | Why | Check |
|---|---|---|
| Node 24 | The code uses Node 24 features (`--env-file-if-exists`) | `node -v` |
| Corepack (ships with Node) | Installs the exact pnpm version in `package.json` | `corepack --version` |
| Docker with Compose | Runs Postgres and Jaeger | `docker compose version` |
| `curl` and `jq` | Used in the walkthrough | `jq --version` |
| A bash shell | On Windows use WSL or Git Bash | |

Resources: about 1 GB of free RAM and 1 GB of disk for images. Free ports: 3000, 4010, 5544, 16686, 4318.
No paid account is needed, except for the optional live LLM call (section 9).

## 3. Quick start

```bash
git clone https://github.com/desiarchitect/tadka-ai.git && cd tadka-ai
git checkout ep00-start
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose --profile observability up -d --wait
pnpm db:migrate && pnpm db:seed
pnpm dev
```

`pnpm dev` stays in the foreground. Open a second terminal for the walkthrough in section 5.

## 4. The commands, one by one

### `git checkout ep00-start`
Switches to this episode's branch. Each episode lives on its own branch, so this is the code exactly as it is
at the end of this episode. `main` only holds the overview.

### `corepack enable`
Turns on Corepack so `pnpm` resolves to the version pinned in `package.json` (`packageManager`). Without it
you may get a different pnpm and a different lockfile.

### `pnpm install --frozen-lockfile`
Installs the dependencies listed in `pnpm-lock.yaml` and fails if `package.json` and the lockfile disagree.
This is what CI runs, so a green install here means a green install there. Install scripts are switched off
for `esbuild` and `protobufjs` in `pnpm-workspace.yaml`; neither needs one.

### `cp .env.example .env`
Creates your local settings. `.env` is git-ignored: never commit it.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://tadka:tadka_local@localhost:5544/tadka` | Where the API finds Postgres |
| `FAKE_PSP_URL` | `http://localhost:4010` | Where the API finds the fake payment provider |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where traces are sent. Delete or empty it to run without tracing |
| `AZURE_RESOURCE_NAME`, `AZURE_API_KEY` | empty | Only for the live LLM call (section 9) |
| `AZURE_DEPLOYMENT` | `gpt-5.4-mini` | Name of the model deployment. The series uses `gpt-5.4-mini` on Microsoft Foundry |
| `M0_BUDGET_USD` | `5` | Hard spending cap enforced by the probe |

The database credentials are local-only defaults and match `docker-compose.yml`.
Do not set `PORT` in `.env`: the API (3000) and the fake provider (4010) both read it and would collide.

### `docker compose --profile observability up -d --wait`
Starts two containers and waits until they are healthy:

- `tadka-ai-postgres`: Postgres 16 with pgvector, on host port **5544** (not 5432, so it never clashes with a Postgres you already run). Data lives in the `pgdata` volume.
- `tadka-ai-jaeger`: the trace viewer. UI on **16686**, accepts traces on **4318**. It is behind the `observability` profile, so it only starts when you ask for that profile.

`-d` runs them in the background. `--wait` blocks until Postgres passes its health check. Without it, the next step can
fail because the database is not accepting connections yet.

### `pnpm db:migrate`
Applies the SQL files in `apps/api/migrations` to the database. The schema has one Postgres schema per module
(`identity`, `restaurant`, `ordering`, `payment`) and no foreign keys across schemas, so a module can be split out later.
Safe to run again: applied migrations are skipped.

### `pnpm db:seed`
**Wipes** the tables and inserts synthetic data: 4 users, 3 restaurants with menus, and 9 orders (8 in progress or delivered,
each with a captured payment, plus one unpaid `Placed` order for Rahul). No real people, addresses or numbers.
Run it any time you want a clean database.

| User | Role | Password |
|---|---|---|
| `rahul@tadka.test` | Customer | `Password123!` |
| `aman@tadka.test` | Customer | `Password123!` |
| `owner@tadka.test` | RestaurantOwner (Spice Garden) | `Password123!` |
| `admin@tadka.test` | Admin | `Password123!` |

### `pnpm dev`
Starts both apps in parallel:

- the API on port 3000 (`apps/api`)
- the fake payment provider on port 4010 (`apps/fake-psp`)

On start the API prints `JWT_PRIVATE_JWK unset: using a fresh dev signing key`. That means tokens are signed with a key
created at start-up, so **every restart invalidates all tokens**. Log in again after a restart.
The fake provider keeps its state in memory, so a restart is a clean slate for it (see section 7).

## 5. Walkthrough: what to run and what you should see

Run these in a second terminal. First, a helper that logs in and prints a token:

```bash
login() {
  curl -s -XPOST localhost:3000/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"Password123!\"}" | jq -r .accessToken
}
RAHUL=$(login rahul@tadka.test)
```

**Health.** `curl -s localhost:3000/health` and `curl -s localhost:4010/health` both return `{"status":"ok"}`.

**Public data.** `curl -s localhost:3000/restaurants` lists Biryani House, Chai Point and Spice Garden.
`curl -s localhost:3000/restaurants/aaaaaaaa-0000-4000-8000-000000000001/menu` shows Spice Garden's items. Prices are in paise.

**Login.** The login call returns `accessToken`, `refreshToken` and `expiresIn: 900`. The access token is a 15-minute
signed JWT; the refresh token is an opaque value, and the database stores only its hash.

**Your own orders only.**

```bash
curl -s localhost:3000/orders -H "authorization: Bearer $RAHUL" | jq 'length, [.[].status]'
```

Rahul sees 5 orders: `Placed`, `Confirmed`, `Preparing`, `OutForDelivery`, `Delivered`.

**Someone else's order looks like it does not exist.**

```bash
AMAN=$(login aman@tadka.test)
AMANS_ORDER=$(curl -s localhost:3000/orders -H "authorization: Bearer $AMAN" | jq -r '.[0].id')
curl -s -w ' [%{http_code}]\n' localhost:3000/orders/$AMANS_ORDER -H "authorization: Bearer $RAHUL"
```

Result: `{"error":"order_not_found"} [404]`. It is 404, not 403, so the answer does not even confirm that the order exists.

**No token.** `curl -s -w ' [%{http_code}]\n' localhost:3000/orders` returns `{"error":"missing_token"} [401]`.

**Roles see different things.** The owner sees only Spice Garden's 5 orders, without delivery address or phone. The admin sees all 9.

```bash
OWNER=$(login owner@tadka.test); ADMIN=$(login admin@tadka.test)
curl -s localhost:3000/orders -H "authorization: Bearer $OWNER" | jq 'length, (.[0] | keys)'
curl -s localhost:3000/orders -H "authorization: Bearer $ADMIN" | jq 'length'
```

**Pay for an order.**

```bash
ORDER=bbbbbbbb-0000-4000-8000-000000000001     # Rahul's unpaid order
curl -s -XPOST localhost:3000/orders/$ORDER/pay -H "authorization: Bearer $RAHUL" | jq '{status, version}'
```

Result: `{"status":"Confirmed","version":2}`. The API charged the fake provider, stored the payment and moved the order
from `Placed` to `Confirmed`. Run it again and you get the same answer with no second charge: the charge uses a stable
key (`charge:<orderId>`), and the provider remembers it.

**Make the provider misbehave.** The fake provider has a control endpoint, `POST :4010/__levers`, with values
`succeed`, `decline`, `timeout` and `error`. Each scenario below needs a clean state first, so run the reset line before it.

Reset: press Ctrl+C in the `pnpm dev` terminal, run `pnpm db:seed && pnpm dev` again, then log in again
(`RAHUL=$(login rahul@tadka.test)`). This gives you a fresh unpaid order and a fresh provider.

| Scenario | Command | What you see | Why |
|---|---|---|---|
| Decline | `curl -s -XPOST localhost:4010/__levers -H 'content-type: application/json' -d '{"charges":"decline"}'` then pay | `{"error":"payment_declined"} [402]`. The order stays `Placed` | A decline is a final answer. The API records the payment as declined, so even after you set the lever back to `succeed`, paying the same order again still returns 402. The provider also remembers the decline for that key |
| Timeout | lever `{"charges":"timeout","timeoutMs":1000}` then pay | After about 1 second the order is `Confirmed` | The provider applied the charge but never answered in time. The API did not guess: it asked the provider "what happened to this key?" and found the charge |
| Error, then retry | lever `{"charges":"error"}`, pay, then lever `{"charges":"succeed"}` and pay again | First: `{"error":"payment_outcome_unknown"} [502]`. After the retry: `Confirmed` | An error means the outcome is unknown, so the payment is marked `unknown`. The retry reuses the same key, so the customer is charged once |

**Refresh and logout.** `POST /auth/refresh` with `{"refreshToken": "..."}` returns a new pair and kills the old refresh token.
Presenting the old one again returns `{"error":"invalid_refresh_token"} [401]` and revokes the whole family of tokens,
which is how a stolen token is detected. `POST /auth/logout` revokes the family and returns 204.

**Bad input.** A wrong password and an unknown email both return `{"error":"invalid_credentials"} [401]`. A malformed id such as
`/orders/not-a-uuid` returns `{"error":"invalid_request"} [400]`.

### The order state machine

```
Placed -> Confirmed -> Preparing -> OutForDelivery -> Delivered
   \          \
    +----------+--> Cancelled
```

Anything else is rejected, including going backwards. Only `pay` (`Placed` to `Confirmed`) is exposed over HTTP in this branch.
Each change uses a `version` column, so two writers cannot both update the same order.

## 6. Traces in Jaeger

Open http://localhost:16686, choose the service `tadka-api` and find a `POST` request for `/orders/.../pay`.
One payment is **15 spans across two services** (`tadka-api` and `tadka-fake-psp`):

```
tadka-api      POST
  orders.pay                       (service)
    SELECT                         (database)
    payments.chargeForOrder        (service)
      INSERT / SELECT              (database)
      POST                         (HTTP call to the provider)
        tadka-fake-psp  POST       (the provider's own process)
      UPDATE                       (database)
    UPDATE                         (database)
```

The HTTP span is named just `POST` because route-level naming is not wired yet. That is a known gap.

## 7. Resetting state

| You want | Do this | Note |
|---|---|---|
| Fresh database | `pnpm db:seed` | Wipes and re-creates all data |
| Fresh fake provider | Restart `pnpm dev` | Its charges and idempotency keys live in memory |
| A clean demo | Both of the above | **Seeding alone is not enough**: the provider still remembers a key from a previous payment and replays that result |
| Everything gone | `docker compose --profile observability down -v` | `-v` also deletes the database volume |

## 8. Tests

```bash
pnpm typecheck     # TypeScript, both apps
pnpm test          # needs the postgres container; drops and re-creates a separate tadka_test database
```

Expected: 8 fake-provider tests and 33 API tests pass. Your dev database is never touched.

| File | What it proves |
|---|---|
| `access-tokens.test.ts` (9) | No token, bad signature, expired, wrong issuer, wrong audience, wrong algorithm, wrong type all return 401; a valid token returns 200 |
| `refresh-tokens.test.ts` (9) | Rotation, reuse detection, concurrent refresh, logout, expiry, only a hash is stored |
| `orders.test.ts` (6) | Customers see only their orders, other people's orders return 404, owners see no address, admins see all, the state machine rejects bad moves |
| `payments.test.ts` (5) | Cross-user payment is refused, timeout is resolved by lookup, error then retry charges once, paying twice is a no-op, the money constraint |
| `triage.test.ts` (4) | The LLM call returns a typed object and rejects a bad shape; the budget guard refuses before sending |
| `fake-psp/test/idempotency.test.ts` (8) | Key required, replay, key reuse with a different body, concurrent requests, timed-out and errored charges, final declines, refund cap |

## 9. The LLM probe

```bash
pnpm probe:llm                 # dry run: a fake model, no key, no network, no cost
pnpm probe:llm -- --live       # ONE real call to the series model (gpt-5.4-mini on Microsoft Foundry)
```

The dry run prints a typed answer (`intent`, `language`, `needsHuman`, `summary`) from a fake model. It proves the
code path and the schema, not the provider.

The series uses `gpt-5.4-mini` deployed on Microsoft Foundry (deployment type Global Standard). To run the live call you need your own Foundry resource with that deployment:

1. Put `AZURE_RESOURCE_NAME` and `AZURE_API_KEY` in `.env`. If you named your deployment something else, set `AZURE_DEPLOYMENT` too.
2. Run `pnpm probe:llm -- --live`.

What the live call does, and why:

| Setting | Why |
|---|---|
| One synthetic Hinglish message | No real customer data leaves your machine |
| `reasoningEffort: 'none'` | A classification does not need reasoning tokens, which are billed as output |
| `maxOutputTokens: 400`, `maxRetries: 0` | A hard ceiling per call, and no silent retries that spend money |
| `store: false` | The Responses API keeps responses by default; this asks it not to |
| Budget ledger `.m0-usage.json` | Before sending, the probe adds the worst-case cost of this call to what you have spent. If that would pass `M0_BUDGET_USD` (default 5), it refuses and sends nothing |

It prints the deployment name, latency, token usage and cost. One call costs a fraction of a cent. Also set a budget alert on
your Azure resource group (not required to run the branch): an alert only notifies, while the ledger is what stops the call.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm db:migrate` fails right after `docker compose up` | Postgres was not ready yet | Use `up -d --wait`, or wait a few seconds and re-run |
| `container name ... is already in use` | A stack from another checkout uses the same fixed container names | `docker compose down -v` in that other checkout, or `docker rm -f tadka-ai-postgres tadka-ai-jaeger` |
| `EADDRINUSE` on 3000 or 4010 | A previous `pnpm dev` is still running, or another program uses the port | Stop the old process, then start again |
| Everything returns 401 after a restart | The dev signing key is regenerated on every start | Log in again |
| Pay ignores the lever you set | The order was already paid or declined. After a re-seed the provider still replays its stored result for that order's key | Restart `pnpm dev` after `pnpm db:seed` (section 7) |
| `AZURE_API_KEY and AZURE_RESOURCE_NAME must be set` | `--live` without credentials | Fill them in `.env` |
| No traces in Jaeger | Jaeger is not running, or `OTEL_EXPORTER_OTLP_ENDPOINT` is empty | Start with `--profile observability`; check `.env` |
| Tests fail to connect | The postgres container is not running | `docker compose up -d --wait` |

## 11. Teardown

```bash
# Ctrl+C in the pnpm dev terminal, then:
docker compose --profile observability down -v
```

This removes both containers, the network and the database volume.
