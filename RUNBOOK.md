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

## 2. Install these first

Do this before running the first command in section 3. It works on Windows 10/11, macOS and Linux.

> **Windows: run every command in this runbook in Git Bash** (installed with Git below), not in PowerShell or Command Prompt.
> The commands use bash syntax, and `curl` in PowerShell is a different program.

What you need:

| Tool | Version | Why |
|---|---|---|
| Git | any recent | Downloads the code |
| Node.js | **24.x** (not 22, not 25 or newer) | Runs the code. `package.json` requires `>=24 <25` |
| pnpm | **12.11.2** | The package manager this repository is locked to |
| Docker with Compose | recent (Docker Desktop on Windows and macOS) | Runs Postgres and Jaeger |
| `curl` | any | Calls the API in the walkthrough. Included with macOS, Linux and Git Bash |
| `jq` | any | Reads JSON in the walkthrough |

Also free: about 1 GB of RAM and 1 GB of disk for images, and ports 3000, 4010, 5544, 16686 and 4318.
No paid account is needed, except for the optional live LLM call (section 9).

### Windows 10/11

Run the install commands in PowerShell or Windows Terminal. They use `winget`, which comes with current Windows.

1. **Git** (this also installs Git Bash):
   ```powershell
   winget install --id Git.Git -e
   ```
2. **Node.js 24:**
   ```powershell
   winget install --id OpenJS.NodeJS.LTS -e --version 24.20.0
   ```
   If that exact version is not offered, download the Node 24 Windows installer from [nodejs.org](https://nodejs.org/en/download) and choose version 24.
   Newer Node versions will not work. If `node -v` already prints v25 or higher, uninstall that Node first (`winget uninstall OpenJS.NodeJS`) and open a new terminal before installing Node 24.
3. **Docker Desktop.** Download it from the [Docker Desktop for Windows page](https://docs.docker.com/desktop/setup/install/windows-install/)
   and run the installer (or `winget install -e --id Docker.DockerDesktop`). It needs WSL 2 and hardware virtualization turned on in your BIOS/UEFI,
   and Docker recommends 8 GB of RAM. Restart if the installer asks, then open **Docker Desktop** once and wait until it reports that Docker is running.
4. **jq:**
   ```powershell
   winget install --id jqlang.jq -e
   ```
5. **Close every terminal, then open Git Bash** from the Start menu. A new window is needed so the new programs are on the PATH.
6. **pnpm**, in Git Bash:
   ```bash
   npm install -g pnpm@12.11.2
   ```
   Windows users install pnpm with npm because `corepack enable` needs administrator rights there.

Prefer Linux on Windows? Install WSL with Ubuntu, follow the Linux steps below inside it, and in Docker Desktop turn on WSL integration for that distribution
(**Settings**, **Resources**, **WSL integration**).

### macOS

1. Install [Homebrew](https://brew.sh), then: `brew install git jq` and `brew install --cask docker`. Open **Docker** once and wait until it is running.
2. Install Node 24 with [nvm](https://github.com/nvm-sh/nvm) (follow its install steps), then open a new terminal and run `nvm install 24`.
3. Install pnpm: `corepack enable`. If that fails with a permission error, run `npm install -g pnpm@12.11.2` instead.

### Linux

1. Install Git, curl and jq with your package manager, for example `sudo apt install git curl jq`.
2. Install Docker Engine with the Compose plugin by following [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) for your distribution.
   Then run `sudo usermod -aG docker $USER` and log out and back in, so you can run `docker` without `sudo`.
3. Install Node 24 with [nvm](https://github.com/nvm-sh/nvm), then `nvm install 24`.
4. Install pnpm: `corepack enable` (use `sudo` if you get a permission error), or `npm install -g pnpm@12.11.2`.

### Check that everything is installed

Run these in your terminal (Git Bash on Windows). Every line should print a version, and the last one should not print an error.

```bash
node -v                  # v24.something
pnpm -v                  # 12.11.2
git --version
docker --version
docker compose version
curl --version
jq --version
docker info              # an error here means Docker is not running: start Docker Desktop and wait
```

If `node -v` prints anything other than v24, fix that first. Everything after this depends on it.

## 3. Quick start

```bash
git clone https://github.com/desiarchitect/tadka-ai.git && cd tadka-ai
git checkout ep00-start
pnpm -v                 # must print 12.11.2 (see section 2 if it does not)
pnpm install --frozen-lockfile
cp .env.example .env
docker compose --profile observability up -d --wait
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Run these in Git Bash on Windows, or any terminal on macOS and Linux. `pnpm dev` stays in the foreground. Open a second terminal for the walkthrough in section 5.

## 4. The commands, one by one

### `git checkout ep00-start`
Switches to this episode's branch. Each episode lives on its own branch, so this is the code exactly as it is
at the end of this episode. `main` only holds the overview.

### `pnpm -v`
Checks that the right pnpm is installed. This repository is locked to pnpm 12.11.2 (`packageManager` in `package.json`), so a different version
could produce a different lockfile. If it prints something else, or "command not found", go back to section 2 and install pnpm.

### `pnpm install --frozen-lockfile`
Installs the dependencies listed in `pnpm-lock.yaml` and fails if `package.json` and the lockfile disagree.
This is what CI runs, so a green install here means a green install there. Install scripts are switched off
for `esbuild` and `protobufjs` in `pnpm-workspace.yaml`; neither needs one.

### Create your `.env` file
`.env` holds your local settings and secrets. It is git-ignored, so it is never committed. You make it by copying the template.

**Step 1: copy the template** (run from the repository root).

| Shell | Command |
|---|---|
| macOS, Linux, WSL, Git Bash | `cp .env.example .env` |
| Windows PowerShell | `Copy-Item .env.example .env` |

**Step 2: check that Git ignores it.** `git check-ignore .env` should print `.env`. If it prints nothing, stop and do not add secrets.

**Step 3: open `.env` in any editor** and fill in only what you need. Write `NAME=value` with no spaces around `=` and no quotes.

| Variable | Default | Needed? | What it does |
|---|---|---|---|
| `DATABASE_URL` | `postgres://tadka:tadka_local@localhost:5544/tadka` | No, keep the default | Where the API finds Postgres. Matches `docker-compose.yml` |
| `FAKE_PSP_URL` | `http://localhost:4010` | No, keep the default | Where the API finds the fake payment provider |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | No, keep the default | Where traces are sent. Empty it to run without tracing |
| `AZURE_RESOURCE_NAME` | empty | Only for `--live` | The name of your Azure resource. See section 9 |
| `AZURE_API_KEY` | empty | Only for `--live` | KEY 1 of that resource. See section 9 |
| `AZURE_DEPLOYMENT` | `gpt-5.4-mini` | Only for `--live` | The name you gave the model deployment. See section 9 |
| `M0_BUDGET_USD` | `5` | No | Hard spending cap enforced by the probe |

Everything except the three `AZURE_*` values already works as copied. You can run the whole branch, including all tests and
the dry-run probe, without filling anything in.

Do not set `PORT` in `.env`: the API (3000) and the fake provider (4010) both read it and would collide.
Never paste your key into a chat, an issue or a commit.

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

The HTTP spans show only the method (`POST`), not the route.

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

### Run the live call: where each Azure value goes

The series uses `gpt-5.4-mini` deployed on Microsoft Foundry (deployment type Global Standard). To run the live call you need an Azure
subscription and your own resource with that model deployed. Do this once.

**A. Create the resource.** Pick one way.

- *Azure portal:* Create a resource, search for **Azure OpenAI**, select **Create**. On the **Basics** tab choose a subscription, a resource group,
  a region and a **Name**, with pricing tier Standard. Select **Review + submit**, then **Create**, then **Go to resource**.
  Pick a region where `gpt-5.4-mini` is available as Global Standard (check the model's region table in Microsoft's Foundry Models docs).
- *Azure CLI:*

  ```bash
  az login
  az group create -n tadka-rg -l eastus2        # eastus2 is an example; use a region that offers the model
  az cognitiveservices account create -n my-tadka-ai -g tadka-rg \
    --kind AIServices --sku S0 -l eastus2 --custom-domain my-tadka-ai
  ```

  The name you pass with `-n` (here `my-tadka-ai`) must be unique across Azure. Remember it: it is your resource name.

**B. Deploy the model.** Sign in at [ai.azure.com](https://ai.azure.com), open your resource, and select **Deployments**
(or **Models + endpoints** in newer portal versions). Select **+ Deploy model**, then **Deploy base model**, choose **gpt-5.4-mini**, and **Confirm**.
Set:

- **Deployment name**: `gpt-5.4-mini`. Keep the name starting with `gpt-5.4-mini` (for example `gpt-5.4-mini-1` also works): the AI SDK reads the name
  to know this is a reasoning model.
- **Deployment type**: Global Standard (shown as **Global-Standard** in some portal versions).

Select **Deploy** and wait until the state shows **Succeeded**. CLI equivalent:

```bash
az cognitiveservices account deployment create -n my-tadka-ai -g tadka-rg \
  --deployment-name gpt-5.4-mini --model-name gpt-5.4-mini --model-version 2026-03-17 \
  --model-format OpenAI --sku-name GlobalStandard --sku-capacity 10
```

`--sku-capacity 10` is a rate limit of 10k tokens per minute. It does not change the price, which is per token.

**C. Copy the values.** In the Azure portal open your resource and go to **Resource Management**, then **Keys and Endpoint**.
Copy **KEY 1** and **Endpoint**. CLI equivalent: `az cognitiveservices account keys list -n my-tadka-ai -g tadka-rg` (use `key1`).

**D. Put them in `.env`.**

| Azure shows | Goes in `.env` as | Example |
|---|---|---|
| **Endpoint**, for example `https://my-tadka-ai.openai.azure.com/`. Take only the name between `https://` and the first dot | `AZURE_RESOURCE_NAME` | `AZURE_RESOURCE_NAME=my-tadka-ai` |
| **KEY 1** | `AZURE_API_KEY` | `AZURE_API_KEY=<paste the key>` |
| The **Deployment name** you chose in step B | `AZURE_DEPLOYMENT` | `AZURE_DEPLOYMENT=gpt-5.4-mini` |

Do not paste the full endpoint URL into `AZURE_RESOURCE_NAME`: the code builds `https://<name>.openai.azure.com/openai/v1` itself.
Treat KEY 1 like a password. If it ever leaks, select **Regenerate Key** on the same **Keys and Endpoint** page; the old key stops working immediately.

**E. Run it.**

```bash
pnpm probe:llm -- --live
```

A good run prints JSON with `"mode": "live"`, your `deployment`, a typed `output` (`intent`, `language`, `needsHuman`, `summary`),
`latencyMs`, token `usage`, and `costUsd`. If it fails:

| Message or symptom | Likely cause | Fix |
|---|---|---|
| `AZURE_API_KEY and AZURE_RESOURCE_NAME must be set` | A value is empty or `.env` is not in the repository root | Fill both, save, run again from the repository root |
| 401 (access denied) | Wrong or regenerated key | Copy KEY 1 again |
| 404 or `DeploymentNotFound` | `AZURE_DEPLOYMENT` does not match the deployment name | Copy the name exactly from the **Deployments** list |
| `ENOTFOUND` or a connection error | `AZURE_RESOURCE_NAME` is wrong (for example the full URL) | Use only the name before the first dot |
| An error about `reasoningEffort` | The deployment does not accept `none` | Change `reasoningEffort` to `'low'` in `apps/api/src/assist/triage.ts` and remove the `temperature` line |

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
| `EADDRINUSE` on 3000 or 4010 | A previous `pnpm dev` is still running, or another program uses the port | Stop the old process, then start again. On Windows (Git Bash): `netstat -ano \| findstr :3000` shows the process id, then `taskkill //PID <id> //F` (the double slashes are needed in Git Bash) |
| `docker: error during connect` or `failed to connect to the docker API` | Docker is not running | Start Docker Desktop and wait until it says Docker is running |
| `command not found` or `is not recognized` for `pnpm`, `node`, `jq` or `docker` | The program is not installed, or the terminal was opened before it was installed | Open a new terminal (Git Bash on Windows), then check with the list at the end of section 2 |
| `Unsupported engine` or a Node error | Wrong Node version | `node -v` must print v24; install Node 24 (section 2) |
| `corepack` is not recognized | Node 25 and later no longer include corepack | Install Node 24, then `npm install -g pnpm@12.11.2` |
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
