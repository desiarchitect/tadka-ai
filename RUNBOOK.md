# Runbook: `ep02-typed-tool-calling`

Everything you need to run this branch, what each command does, and what you should see.
Every command below was run on a clean checkout before this runbook was written.

## 1. What this branch is

`ep02-typed-tool-calling` is episode 2: **typed tool calling with server-side identity**. It starts from episode 1
(`ep01-structured-intent`: a deterministic order-status route and a free-text intent classifier) and adds an assistant that
can look things up with tools:

> The model requests a tool. The executor validates the request. The service enforces access. The application decides what can be claimed.

You first see the failure: a naive tool that takes the user id from the model hands Rahul the address on Aman's order. Then
the fix: three read-only tools whose identity comes from the verified token, an executor that validates every call, and a
loop with hard limits. The model chooses tools and chooses which results answer the question. It never writes the reply:
the application renders it from the tool results, so an order status, a total or a price can only come from the database.

What you will see when it runs:

| You will see | Where |
|---|---|
| A REST API with login, token refresh, restaurants, orders, payment and assist triage | `http://localhost:3000` |
| A React + Vite customer-facing visual client with developer telemetry panel | `http://localhost:5173` |
| A fake payment provider you can make succeed, decline, time out or fail on demand | `http://localhost:4010` |
| One request traced across services | Jaeger at `http://localhost:16686` |
| One typed answer from a language model, from Microsoft Foundry or the direct OpenAI API | `pnpm probe:llm` (section 11) |
| A deterministic order-status route and a free-text intent route | Section 6 |
| Keyword rules and an LLM compared on 40 frozen messages | `pnpm eval:intent` (section 6) |
| The naive tool leaking another customer's address, and the fix | Section 7 |
| `POST /assist/chat`: a question answered with tools | Section 7 |
| 404 passing tests (356 API + 13 fake provider + 35 web client) | `pnpm test` |

What is **not** in this branch, on purpose: conversations (each question stands alone), tools that change anything,
RAG, and defences against prompt injection beyond labelling database text as data. Those arrive in later episode branches.

## 2. Install these first

Do this before running the first command in section 3. It works on Windows 10/11, macOS and Linux.

> **Windows: you can use either PowerShell or Git Bash.** Setup commands (`git`, `pnpm`, `docker`) are the same in both. Where PowerShell needs
> different syntax, this runbook gives a PowerShell version next to the bash one: the install check (section 2), Quick start (section 3),
> the `.env` copy (section 4), the walkthrough (section 5, "In PowerShell") and teardown (section 13). The bash walkthrough also needs `curl` and `jq`; the PowerShell one does not.

What you need:

| Tool | Version | Why |
|---|---|---|
| Git | any recent | Downloads the code |
| Node.js | **24.x or 26.x** (not 22, not 25) | Runs the code. `package.json` requires `>=24 <27`. Node 24 is the long-term-support release; Node 26 is the newest |
| pnpm | **12.11.2** | The package manager this repository is locked to |
| Docker with Compose | recent (Docker Desktop on Windows and macOS) | Runs Postgres and Jaeger |
| `curl` | any | Calls the API in the bash walkthrough. Included with macOS, Linux and Git Bash. Not needed in PowerShell |
| `jq` | any | Reads JSON in the bash walkthrough. Not needed in PowerShell |

Also free: about 1 GB of RAM and 1 GB of disk for images, and ports 3000, 4010, 5173, 5544, 16686 and 4318.
No paid account is needed, except for the optional live LLM call (section 11).

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
   Node 26 also works: download its installer from the same page. Node 22 and Node 25 do not work. If `node -v` prints one of those, uninstall it first (`winget uninstall OpenJS.NodeJS`) and open a new terminal before installing.
3. **Docker Desktop.** Download it from the [Docker Desktop for Windows page](https://docs.docker.com/desktop/setup/install/windows-install/)
   and run the installer (or `winget install -e --id Docker.DockerDesktop`). It needs WSL 2 and hardware virtualization turned on in your BIOS/UEFI,
   and Docker recommends 8 GB of RAM. Restart if the installer asks, then open **Docker Desktop** once and wait until it reports that Docker is running.
4. **jq** (only if you use the bash walkthrough in Git Bash; skip it for PowerShell):
   ```powershell
   winget install --id jqlang.jq -e
   ```
5. **Close every terminal, then open a new PowerShell (or Git Bash) window.** A new window is needed so the new programs are on the PATH.
6. **pnpm**:
   ```powershell
   npm install -g pnpm@12.11.2
   ```
   pnpm is installed with npm on every system because Node 25 and later no longer include `corepack`.

Prefer Linux on Windows? Install WSL with Ubuntu, follow the Linux steps below inside it, and in Docker Desktop turn on WSL integration for that distribution
(**Settings**, **Resources**, **WSL integration**).

### macOS

1. Install [Homebrew](https://brew.sh), then: `brew install git jq` and `brew install --cask docker`. Open **Docker** once and wait until it is running.
2. Install Node 24 with [nvm](https://github.com/nvm-sh/nvm) (follow its install steps), then open a new terminal and run `nvm install 24`.
3. Install pnpm: `npm install -g pnpm@12.11.2`.

### Linux

1. Install Git, curl and jq with your package manager, for example `sudo apt install git curl jq`.
2. Install Docker Engine with the Compose plugin by following [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) for your distribution.
   Then run `sudo usermod -aG docker $USER` and log out and back in, so you can run `docker` without `sudo`.
3. Install Node 24 with [nvm](https://github.com/nvm-sh/nvm), then `nvm install 24`.
4. Install pnpm: `npm install -g pnpm@12.11.2`.

### Check that everything is installed

Run these in your terminal. Every line should print a version, and the last one should not print an error. (In PowerShell, leave out the `curl` and `jq` lines and the `#` comments are fine.)

```bash
node -v                  # v24.x or v26.x
pnpm -v                  # 12.11.2
git --version
docker --version
docker compose version
curl --version
jq --version
docker info              # an error here means Docker is not running: start Docker Desktop and wait
```

If `node -v` prints anything other than v24 or v26, fix that first. Everything after this depends on it.

## 3. Quick start

```bash
git clone https://github.com/desiarchitect/tadka-ai.git && cd tadka-ai
git checkout ep02-typed-tool-calling
pnpm -v                 # must print 12.11.2 (see section 2 if it does not)
pnpm install --frozen-lockfile
cp .env.example .env
docker compose --profile observability up -d --wait
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Run these in Git Bash on Windows, or any terminal on macOS and Linux. `pnpm dev` stays in the foreground. Open a second terminal for the walkthrough in section 5.

**Windows PowerShell version** (the same steps; `&&` is not used because older PowerShell does not support it):

```powershell
git clone https://github.com/desiarchitect/tadka-ai.git
cd tadka-ai
git checkout ep02-typed-tool-calling
pnpm -v                 # must print 12.11.2
pnpm install --frozen-lockfile
Copy-Item .env.example .env
docker compose --profile observability up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm dev
```

> **Before you open the browser page:** `.env` copies as `DEMO_MODE=0`, so the assistant has no model yet and answers
> `503 provider_not_configured`. Pick one: add provider credentials (section 10), or set `DEMO_MODE=1` in `.env` and restart `pnpm dev`
> for clearly labelled SIMULATED answers. Section 5 ("Recording a demo") says which to choose.

## 4. The commands, one by one

### `git checkout ep02-typed-tool-calling`
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
| `LLM_PROVIDER` | empty | Only when you have credentials (for `--live`, `/assist/chat` and section 7) | Which provider to call: `azure` (Microsoft Foundry) or `openai` (direct API). **Leave it empty until you have credentials**: choosing a provider without its credentials stops the API at startup. See "What starts, and what refuses to start" below and section 10 |
| `LLM_MODEL` | `gpt-5.4-mini` | No | The model the budget prices and the evaluations record. Not the Azure deployment name |
| `AZURE_RESOURCE_NAME` | empty | With `LLM_PROVIDER=azure` | The name of your Azure resource. See section 11 |
| `AZURE_API_KEY` | empty | With `LLM_PROVIDER=azure` | KEY 1 of that resource. See section 11 |
| `AZURE_DEPLOYMENT` | `gpt-5.4-mini` | With `LLM_PROVIDER=azure` | The name you gave the model deployment. It must be named like a GPT model. See section 11 |
| `OPENAI_API_KEY` | empty | With `LLM_PROVIDER=openai` | Your key for the direct OpenAI API. See section 11 |
| `EVAL_BUDGET_USD` | `0.5` | No | Spending cap for one `pnpm eval:intent --live` run (section 6) |
| `M0_BUDGET_USD` | `5` | No | Hard spending cap for everything sent from this checkout (probe, evaluation, assistant). It does **not** limit the HTTP triage route |
| `ASSIST_MAX_OUTPUT_TOKENS` | `400` | No | Output cap sent with every assistant request (section 7) |
| `ASSIST_TURN_BUDGET_USD` | `0.05` | No | Spending cap for one question to the assistant (section 7) |
| `ASSIST_ESTIMATE_MARGIN` | `1.25` | No | Safety margin on the cost estimate (section 7) |
| `AUDIT_HMAC_KEY` | empty | No | Key for hashing order ids in the audit log. Empty means a new key each start (section 7) |
| `DEMO_MODE` | `0` | No | `1`: `POST /assist/triage` returns SIMULATED answers and calls no model. `0` or empty: off. Anything else: the API refuses to start |
| `TRIAGE_RATE_LIMIT_PER_MIN` | `10` | No | Requests per minute per signed-in user, **per route**, on `POST /assist/triage` and on `POST /assist/intent` (each has its own quota). The name is historical; it covers both |
| `TRIAGE_TIMEOUT_MS` | `15000` | No | Longest the API waits for the model on one request, on both routes. The call is aborted at that point |
| `CORS_ORIGIN` | empty | No | One browser origin allowed to call the API. Empty = `http://localhost:5173` and `:4173` |
| `SHUTDOWN_DEADLINE_MS` | `8000` | No (ops/test knob) | Overall time `Ctrl+C` / SIGTERM may take before the process is forced to exit |

The template as copied starts the whole branch: the API, the fake provider and the page, and all tests and the dry-run probe run.
Without a provider the assistant is simply off (see the next paragraphs); nothing else needs filling in.

**The browser assistant needs one of two things.** Either provider credentials (section 10), or `DEMO_MODE=1` in `.env`.
With neither, `POST /assist/triage` answers `503 provider_not_configured`: the server never pretends to be a model.
With `DEMO_MODE=1` every answer is marked `simulated: true`, carries `modelId: "demo-mock"`, and the page shows a SIMULATED badge.
If you add real credentials, set `DEMO_MODE=0` (provider settings are not read at all while demo mode is on).

**What starts, and what refuses to start.** The API decides once, at startup, from `DEMO_MODE` and `LLM_PROVIDER`:

| `DEMO_MODE` | `LLM_PROVIDER` and credentials | Result |
|---|---|---|
| `1` | anything, even half filled | **Starts.** Simulated answers. Provider settings are not read and no provider is ever contacted |
| `0` or empty | empty (the template) and no `AZURE_*` / `OPENAI_*` | **Starts, model off.** Triage is `503 provider_not_configured` |
| `0` or empty | `azure` or `openai` with its credentials complete | **Starts, live model.** The log names the deployment |
| `0` or empty | `azure` or `openai` **without** its credentials, or an unknown value, or a deployment not named like a GPT model | **Refuses to start**, exit code 1, one line such as `Startup refused: LLM_PROVIDER=azure needs AZURE_RESOURCE_NAME and AZURE_API_KEY`. It never prints a credential value |
| any other value than `1`, `0` or empty | | **Refuses to start** (`DEMO_MODE must be "1" or "0" (or empty)`) |

A setting that is present but empty (`TRIAGE_RATE_LIMIT_PER_MIN=`) takes its default; a wrong value (`TRIAGE_TIMEOUT_MS=soon`) refuses to start and names the setting.

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
Starts all three apps in parallel:

- the API on port 3000 (`apps/api`)
- the fake payment provider on port 4010 (`apps/fake-psp`)
- the customer visual client on port 5173 (`apps/web`)

On start the API prints `JWT_PRIVATE_JWK unset: using a fresh dev signing key`. That means tokens are signed with a key
created at start-up, so **every restart invalidates all tokens**. Log in again after a restart.
The fake provider keeps its state in memory, so a restart is a clean slate for it (see section 9).

## 5. Walkthrough: what to run and what you should see

### Visual Client Walkthrough (in your browser)

Open `http://localhost:5173` in any browser while `pnpm dev` is running:

1. **Brand & Demo Banner**: View the Tadka branding and the clear reminder that this is a local learning & demo environment running against real backend services.
2. **Simulate Identity**: `pnpm dev` runs the client with its demo sign-in on (`apps/web/.env.development` sets `VITE_DEMO_LOGIN=1`), so it signs in as Rahul (`rahul@tadka.test`) by default. You can switch to Aman or click **Sign Out** at any time. A production build (`pnpm build`) has the demo sign-in off and shows "Not signed in"; for a recorded demo build use `VITE_DEMO_LOGIN=1 pnpm --filter @tadka/web build`.
3. **Submit an Inquiry**: Click the **Late Order (Hinglish)** sample chip or type your own inquiry, then click **Submit to Assistant**. While it waits you can click **Cancel**. Without provider credentials you need `DEMO_MODE=1` (section 4); the answer is then labelled **SIMULATED**.
4. **Review Real Backend Output**: Inspect the actual structured classification returned by `POST /assist/triage`: Intent (`order_status`), Language (`hinglish`), Human Escalation flag, and the triage summary.
5. **Inspect Developer Diagnostics**: Expand the **Developer Demonstration Panel** at the bottom. It displays real values returned by the backend: HTTP status code, client-measured latency, served model name, token usage, Fastify request ID, and the real OpenTelemetry Trace ID.
6. **Verify Distributed Trace**: Copy the Trace ID shown in the Developer Panel and open Jaeger at `http://localhost:16686`. Search for the Trace ID to inspect the full trace.
7. **Verify 401 Enforcement**: Click **Sign Out** in the active caller bar, then submit an inquiry. The UI displays an unauthenticated warning, and the Developer Panel shows `401 Unauthorized` with the safe error code `missing_token`.


### Recording a demo (the explicit opt-in)

`DEMO_MODE` is **off** in the `.env` template on purpose: nothing is ever simulated unless you switched it on. Choose the mode before you record.

| You want to show | Settings in `.env` | What the viewer sees |
|---|---|---|
| **A real model answering** | Provider credentials (section 10) and `DEMO_MODE=0` | No SIMULATED badge. The Developer Panel shows the model name the provider reported. Run `pnpm probe:llm -- --live` once first to prove the credentials work (it makes one paid call, about a tenth of a cent) |
| **The whole flow with no cloud account** | `DEMO_MODE=1` (credentials not needed) | A yellow **SIMULATED** badge on every answer and `demo-mock` as the model in the Developer Panel. The answer does not depend on the message. Say so on camera |
| Neither | `DEMO_MODE=0`, no credentials | An error card: "No AI model is configured on the server" (`503 provider_not_configured`) |

Steps for a simulated recording:

1. In `.env`, set `DEMO_MODE=1` (exactly `1`; `true` or `yes` stop the API from starting).
2. Restart `pnpm dev`. The API prints `DEMO_MODE=1: /assist/triage returns SIMULATED answers (modelId demo-mock). No real model is called.` If you do not see that line, demo mode is not on.
3. Submit a message. Check for the SIMULATED badge and `demo-mock` before you start recording.

Notes: while `DEMO_MODE=1` a real provider setting is ignored, so set it back to `0` (or empty) when you want the real model.
`pnpm dev` also runs the web page with its demo sign-in on, and with the API at `http://localhost:3000`. A production build of the page (`pnpm build`)
has the demo sign-in off and cannot be used to record. For a recorded build of the page, set both settings when you build, because they are compiled into the page:
`VITE_DEMO_LOGIN=1 VITE_API_URL=http://localhost:3000 pnpm --filter @tadka/web build`, then `pnpm --filter @tadka/web preview` (it serves on port 4173, which the API allows).
`VITE_API_URL` is **required** for every production build: without it the page has no API address, shows what to set, and sends nothing (it never falls back to `localhost`).

Run these in a second terminal. First, a helper that logs in and prints a token:

```bash
login() {
  curl -s -XPOST localhost:3000/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"Password123!\"}" | jq -r .accessToken
}
RAHUL=$(login rahul@tadka.test)
```

**Health.** `curl -s localhost:3000/health` and `curl -s localhost:4010/health` both return `{"status":"ok"}`. This is liveness only: it says the process is up, not that Postgres or the model provider is reachable.

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

### In PowerShell

Everything above uses `curl` and `jq`. In PowerShell use this instead. It works in Windows PowerShell 5.1 and PowerShell 7, needs no extra tools, and prints the same JSON.
Paste the helpers once into the second terminal:

```powershell
function Call($Method, $Path, $Token, $Body, $Port = 3000) {
  $p = @{ Method = $Method; Uri = "http://localhost:$Port$Path"; UseBasicParsing = $true; Headers = @{} }
  if ($Token) { $p.Headers.authorization = "Bearer $Token" }
  if ($Method -eq 'POST' -or $Method -eq 'PUT') {
    # Only POST and PUT send a body: Windows PowerShell 5.1 refuses one on GET. Sent as UTF-8 JSON.
    $json = if ($Body) { $Body | ConvertTo-Json -Compress } else { '{}' }
    $p.ContentType = 'application/json; charset=utf-8'
    $p.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  try { (Invoke-WebRequest @p).Content }
  catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'no response' }
    $text = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    try { $text = $text | ConvertFrom-Json | ConvertTo-Json -Compress } catch { }
    "{0} [{1}]" -f $text, $status
  }
}
function Login($Email) { (Call POST /auth/login $null @{ email = $Email; password = 'Password123!' } | ConvertFrom-Json).accessToken }
```

`Call METHOD /path TOKEN BODY PORT` sends the request. Errors print as `{"error":"..."} [status]`, like the bash examples. If the API is not running you see `... [no response]`. Then:

```powershell
Call GET /health                                   # {"status":"ok"}
Call GET /health $null $null 4010                  # the fake provider
Call GET /restaurants
Call GET /restaurants/aaaaaaaa-0000-4000-8000-000000000001/menu     # Spice Garden's items, prices in paise
$RAHUL = Login rahul@tadka.test
(Call GET /orders $RAHUL | ConvertFrom-Json).status -join ','      # Rahul's 5 orders

# Someone else's order looks like it does not exist
$AMAN = Login aman@tadka.test
$AMANS_ORDER = (Call GET /orders $AMAN | ConvertFrom-Json)[0].id
Call GET "/orders/$AMANS_ORDER" $RAHUL             # {"error":"order_not_found"} [404]
Call GET /orders                                   # {"error":"missing_token"} [401]

# Roles see different things
$OWNER = Login owner@tadka.test; $ADMIN = Login admin@tadka.test
(Call GET /orders $OWNER | ConvertFrom-Json).Count     # 5
((Call GET /orders $OWNER | ConvertFrom-Json)[0].PSObject.Properties.Name) -join ','   # no address or phone
(Call GET /orders $ADMIN | ConvertFrom-Json).Count     # 9

# Pay for an order (run it twice: same answer, one charge)
$ORDER = 'bbbbbbbb-0000-4000-8000-000000000001'
Call POST "/orders/$ORDER/pay" $RAHUL              # "status":"Confirmed","version":2

# Make the provider misbehave (reset first, as described above)
Call POST /__levers $null @{ charges = 'decline' } 4010                       # then pay: [402]
Call POST /__levers $null @{ charges = 'timeout'; timeoutMs = 1000 } 4010     # then pay: Confirmed after about 1 s
Call POST /__levers $null @{ charges = 'error' } 4010                         # pay: [502]; set 'succeed', pay again: Confirmed
Call POST /__levers $null @{ charges = 'succeed' } 4010

# Refresh, reuse detection, bad input
$r = Call POST /auth/login $null @{ email = 'rahul@tadka.test'; password = 'Password123!' } | ConvertFrom-Json
Call POST /auth/refresh $null @{ refreshToken = $r.refreshToken }             # a new token pair
Call POST /auth/refresh $null @{ refreshToken = $r.refreshToken }            # {"error":"invalid_refresh_token"} [401]
Call POST /auth/login $null @{ email = 'nobody@tadka.test'; password = 'bad' }  # [401] invalid_credentials
Call GET /orders/not-a-uuid $RAHUL                                            # [400] invalid_request
```

To reset state in PowerShell, press Ctrl+C in the `pnpm dev` window, then run `pnpm db:seed; pnpm dev`, and log in again.

## 6. EP1: classify free text

Everything here uses the walkthrough's `login` helper (bash) or the `Call` and `Login` helpers (PowerShell) from section 5.
Run `pnpm db:seed` and restart `pnpm dev` first if you changed any orders earlier.

### Which classifier is the route using?

When `pnpm dev` starts it prints one line:

- `POST /assist/intent classifier: keyword rules: no LLM settings (set LLM_PROVIDER and its credentials)`: no key needed. The route uses the keyword rules.
- `POST /assist/intent classifier: LLM (Foundry deployment gpt-5.4-mini, model gpt-5.4-mini)` or `LLM (OpenAI model gpt-5.4-mini)`: the provider in `LLM_PROVIDER` is configured in `.env` (section 11). The route uses that model, behind the spending guard.

- `POST /assist/intent classifier: keyword rules (DEMO_MODE=1: no provider is used)`: demo mode. The provider settings are not read and the route never contacts a provider, even if credentials are in `.env`.

Every response says which one answered, in `"classifier": "rules"` or `"classifier": "llm"`, and `"simulated": true` only in demo mode (where the keyword rules answer and nothing came from a model).

### What `/assist/intent` does when something is wrong

It is guarded exactly like `/assist/triage` (one shared guard, `src/assist/guard.ts`):

| Situation | Answer |
|---|---|
| No token | `401 missing_token` or `invalid_token` |
| Owner or admin token | `403 customers_only` |
| A body with another field, an empty text, or more than 500 characters | `400 invalid_request` |
| More than `TRIAGE_RATE_LIMIT_PER_MIN` requests in a minute from one user | `429 rate_limited` with `Retry-After`. Requests rejected above (401, 403) never use up anyone's quota; each user has their own |
| The provider does not answer within `TRIAGE_TIMEOUT_MS` | `502 assistant_unavailable`. The call is aborted, so nothing keeps waiting |
| Key rejected, rate limited by the provider, provider down, network failure, or the spending guard refused | `502 assistant_unavailable`. There is no retry |
| Refusal, or output that is not a valid intent | `200` with `outcome: "refusal"` or `"invalid_output"` and the safe fallback; never a made-up intent and never `other` |

The client only ever sees `assistant_unavailable` for a failed call. **The reason is in the server log**, as a line `assist/intent: no intent was produced` with
`outcome`, `reason` (`provider_timeout`, `provider_auth`, `provider_rate_limited`, `provider_unavailable`, `budget`, `aborted`, `content_filter`, `no_object`...),
the provider's status number and its error code and request id when they look like identifiers. The log never holds the customer's message, the model's output,
provider text, keys or the resource name.

### Demo 1: no LLM at all

A structured request is answered by plain code. The verified token goes to the orders service, which checks ownership.

```bash
RAHUL=$(login rahul@tadka.test)
ORDER=bbbbbbbb-0000-4000-8000-000000000001
curl -s -w ' [%{http_code}]\n' "localhost:3000/assist/order-status?orderId=$ORDER" -H "authorization: Bearer $RAHUL"
```

Result: `{"orderId":"bbbbbbbb-0000-4000-8000-000000000001","status":"Placed"} [200]`.
Another customer's order id returns `{"error":"order_not_found"} [404]`, and no token returns `{"error":"missing_token"} [401]`.

```powershell
$RAHUL = Login rahul@tadka.test
Call GET "/assist/order-status?orderId=bbbbbbbb-0000-4000-8000-000000000001" $RAHUL
```

### Demo 2: free text

```bash
ask() {
  curl -s -w ' [%{http_code}]\n' -XPOST localhost:3000/assist/intent -H "authorization: Bearer $RAHUL" \
    -H 'content-type: application/json' -d "{\"text\":\"$1\"}"
}
ask "Can you cancel my order, please?"
ask "cancel mat karna, bas status batao"
```

```powershell
function Ask($Token, $Text) { Call POST /assist/intent $Token @{ text = $Text } }
Ask $RAHUL 'Can you cancel my order, please?'
Ask $RAHUL 'cancel mat karna, bas status batao'
```

The first message is a cancel request. The second one says "cancel" but means the opposite: the customer wants the status.
With the keyword rules both come back as `cancel_order`, because the word "cancel" wins and a keyword cannot read "mat karna".
The response for a cancel label is always the same: `{"action":"unsupported", ...}`. **No order is cancelled.**

With a model configured, the second message should come back as `order_status`. Whether it does is exactly what the evaluation below measures.

### What the application does with each label

The model returns one field, `{"intent": ...}`. Application code, in `src/assist/next-step.ts`, decides the rest:

| Label | What the application does |
|---|---|
| `order_status` | Looks up the caller's own active orders. One: returns its status. Several: lists them and asks which one (it never guesses). None: says so. If the lookup itself fails you get a 500, never "no orders" |
| `cancel_order` | Nothing is cancelled. Returns `unsupported` |
| `refund_request` | Nothing is refunded. Returns `unsupported` |
| `menu_question` | Returns `unsupported` in this episode |
| `other` | Asks the customer to say more |

Rahul has four active orders, so `order_status` returns `"action":"choose_order"` with those four.

### Outcomes: a failure is not the label "other"

Every call to the model ends in exactly one outcome, returned as `"outcome"`:

| Outcome | Meaning | What the route returns |
|---|---|---|
| `ok` | The model returned a valid intent (this includes a valid `other`) | 200 with the intent and the next step |
| `refusal` | The provider refused or filtered the request | 200 with a safe fallback, nothing executed |
| `invalid_output` | Not JSON, an unknown label, an extra field, or plain prose | 200 with a safe fallback, nothing executed |
| `provider_error` | Timeout, bad key, quota, network, or the spending guard refused | 502 `assistant_unavailable` |

Only customers can use the route. An owner or admin token returns `{"error":"customers_only"} [403]`, and a body with an extra field such as `userId` returns 400:
the identity always comes from the token.

### Demo 3: measure it

```bash
pnpm eval:intent              # dry run, no key, no cost
pnpm eval:intent -- --live    # one request per message to the provider LLM_PROVIDER names
```

The evaluation set is `apps/api/eval/intents.eval.json`: 40 synthetic messages, 19 of them Hinglish, with 5 deliberately hard cases such as
"cancel mat karna, bas status batao". The expected label of every message was fixed before the first comparison. A separate set of 8 messages
(`intents.dev.json`) is where the rules and the prompt were written, so the evaluation set stays untouched.

The dry run prints the rules' real score and a **stand-in** for the model: a fake that repeats the rules' answers. It checks that the harness works.
It tells you nothing about a real model. The rules score 24 of 40 (60%), and they miss all 5 hard cases:

```
rules    24/40     60%   English 47.6%   Hinglish 73.7%   hard cases 0/5
```

Under it you get a list of every miss, as `expected -> got`. For a real number, run `--live`. It prints the same table for the model, how many
requests ended in each outcome, tokens, cost and latency, and writes the full per-message results to `.eval-runs/`.

Read the result honestly. A model that returns valid JSON has not shown it is right: a valid label can still be the wrong one. 40 messages show
how each method behaves on these 40 messages. They are not an accuracy figure for production.

### The spending guard on the live run

`--live` sends one request per message (40) and is guarded twice. Before each request it adds what has actually been spent so far to a
conservative estimate of the next request's cost (the UTF-8 byte length of the prompt counted as tokens, plus a fixed overhead and the full output cap, priced separately; an unpriced model is refused), and stops if that could cross either cap:

| Setting | Default | What it limits |
|---|---|---|
| `EVAL_BUDGET_USD` | `0.5` | This run only |
| `M0_BUDGET_USD` | `5` | Everything ever sent from this checkout (the ledger file `.m0-usage.json`) |

When a cap would be crossed the run stops without sending that request, marks the rest `budget_stop`, and does not retry.
Requests use `maxRetries: 0` and a 100-token output cap, and only synthetic messages are sent.

## 7. EP2: ask with tools

Everything here uses the walkthrough's `login` helper (bash) or the `Call` and `Login` helpers (PowerShell) from section 5.
Run `pnpm db:seed` and restart `pnpm dev` first if you changed any orders earlier.

### Is the assistant on?

When `pnpm dev` starts it prints one line for the assistant:

- `POST /assist/chat: off (no AZURE_* settings)`: the route answers `{"error":"assistant_not_configured"} [503]`. Demo 1 and all the tests still work without a key.
- `POST /assist/chat: Foundry deployment gpt-5.4-mini (priced azure:gpt-5.4-mini)` or `OpenAI model ...`: a provider is configured in `.env` (section 11 shows where each value comes from).

### Demo 1: the naive tool leaks (no key needed)

`apps/api/demo/naive-get-order.ts` is the tool most first attempts look like: the model fills in `{ userId, orderId }` and the
tool trusts both. It lives outside `src/`, is never imported by the app (a test checks this), and exists only to be shown failing.

```bash
pnpm --filter @tadka/api exec vitest run test/naive-tool-demo.test.ts
```

Two tests pass. The first proves the leak: Rahul is logged in, the "model" supplies Aman's user id, and the naive tool returns
`House 7, Sample Road, Mumbai 400001`, the address on Aman's order. The second runs the real tool for the same request:
the strict schema refuses the extra `userId` field, and without it the identity comes from Rahul's token, so the orders
service answers `not_found`. A strict schema helps, but it is not the protection: the ownership check in the service is.

### Demo 2: ask a question

```bash
chat() {
  curl -s -w ' [%{http_code}]\n' -XPOST localhost:3000/assist/chat -H "authorization: Bearer $RAHUL" \
    -H 'content-type: application/json' -d "{\"text\":\"$1\"}"
}
RAHUL=$(login rahul@tadka.test)
chat "What is my latest order, and what is on the menu there?"
```

```powershell
function Chat($Token, $Text) { Call POST /assist/chat $Token @{ text = $Text } }
$RAHUL = Login rahul@tadka.test
Chat $RAHUL 'What is my latest order, and what is on the menu there?'
```

The response has three fields:

| Field | What it is |
|---|---|
| `answer` | The reply, written by application templates from the tool results (`apps/api/src/assist/templates.ts`) |
| `stopReason` | Why the turn ended (table below). `answered` is the normal case |
| `steps` | Every tool the model asked for, with its status: `ok`, `not_found`, `invalid_args` or `failed` |

A typical run asks for `get_my_orders`, then `get_restaurant_menu` for that order's restaurant, and the answer starts with
`Your recent orders, newest first:` followed by the menu. A real model may pick a different route to the answer; the answer
text always comes from the templates.

### Demo 3: someone else's order, and an id that does not exist

```bash
AMAN_ORDER=$(curl -s localhost:3000/orders -H "authorization: Bearer $(login aman@tadka.test)" | jq -r '.[0].id')
chat "What is the status of order $AMAN_ORDER?"
chat "What is the status of order 99999999-9999-4999-8999-999999999999?"
```

```powershell
$AMAN_ORDER = (Call GET /orders (Login aman@tadka.test) | ConvertFrom-Json)[0].id
Chat $RAHUL "What is the status of order $AMAN_ORDER?"
Chat $RAHUL 'What is the status of order 99999999-9999-4999-8999-999999999999?'
```

Both answers are `I couldn't find that order.` with `{"tool":"get_order","status":"not_found"}`. Nothing in the response, and
nothing in the `pnpm dev` log (`"tool":"get_order","status":"not_found"` both times), tells you that the first order exists.
The only place that records the difference is the restricted audit log, `apps/api/logs/security-audit.jsonl`: one
`forbidden_as_not_found` line for Aman's order, with Rahul's user id and a hash of the order id, never the id itself or any order data.
That file is for operators; it is git-ignored and never returned to a caller.

### What the model can and cannot do

| The model can | The model cannot |
|---|---|
| Call `get_my_orders` (the caller's 10 most recent orders, newest first) | Name a user: no tool has a user field, and an extra field is rejected |
| Call `get_order` with an order id | See another customer's order: the orders service returns `not_found` |
| Call `get_restaurant_menu` with a restaurant id (at most 25 items) | Change anything: all three tools are read-only |
| Finish with `final_answer`: which results to show, or ask a fixed clarifying question | Write the reply. Prose instead of a tool call is `invalid_output`, and that text is never shown |

Menu item names come from the database and are labelled `untrusted_data`. That label is not a defence against prompt injection; real defences arrive in a later episode.

### Stop reasons and HTTP statuses

A question the assistant answered is `200`. A question it could **not** answer is a failure: the response keeps the safe fallback
sentence in `answer` (so a page can show it) but the status is not 2xx and `error` is a machine-readable code. The body of a failure is
`{ "error": "<code>", "answer": "<fallback>", "stopReason": "...", "steps": [...] }`. Provider text, prompts and credentials are never in it.

| `stopReason` | What happened | HTTP | `error` | `answer` |
|---|---|---|---|---|
| `answered` | The model named the results that answer the question | 200 | | Rendered from those results |
| `answered` | ...but every result it named failed (a database or backend error) | 503 | `backend_unavailable` | `I couldn't fetch that right now...` |
| `clarify` | The question was unclear or not about orders or menus | 200 | | A fixed question |
| `invalid_output` | Prose instead of a tool call twice, unusable tool calls twice, or a result that does not exist | 502 | `provider_bad_output` | The safe fallback |
| `step_limit`, `tool_call_limit` | The model kept asking for more than the limits allow | 502 | `provider_bad_output` | The safe fallback |
| `refusal` | The provider filtered the request | 502 | `provider_refused` | The safe fallback |
| `provider_error` | The provider failed | 429 `provider_rate_limited` (with `Retry-After`), 502 `provider_auth` or `provider_unavailable`, 504 `provider_timeout`, 503 `provider_not_configured` | as shown | The safe fallback |
| `deadline` | The 20 s limit was reached while the provider was working | 504 | `provider_timeout` | The safe fallback |
| `deadline` | ...while a database read was running | 504 | `turn_timeout` | The safe fallback |
| `budget` | The spending guard stopped the next request before it was sent, or the ledger is blocked or unreadable | 503 | `budget_exhausted` | The safe fallback |
| `history_limit` | The request would have been larger than 32 KB | 200 if results had been gathered (rendered from them), else 502 `provider_bad_output` | | |
| `cancelled` | The client disconnected | (nobody is listening) | | |

Other statuses of the route: `401` no or bad token, `403 customers_only` for an owner or admin token, `400 invalid_request`,
`429 rate_limited` (with `Retry-After`) when one user asks more than `TRIAGE_RATE_LIMIT_PER_MIN` (10) times a minute, `503 assistant_not_configured`
with no model (and always in `DEMO_MODE=1`, which never calls a provider). The limit is per verified user, in this process's memory; requests refused for
authentication or role do not use any quota. It is abuse protection, not a spending cap.

When the client disconnects (closes the tab, cancels the request), the provider call is abandoned and no further tool is started. The
request that already left is charged at its estimate, so nothing stays held. A database query that is already running is not cancelled.

The safe fallback is `Sorry, I can't answer that right now. You can check your orders on the Orders page.`

### Limits

Each limit is enforced on its own; reaching any one ends the turn.

| Limit | Value |
|---|---|
| Model requests per question | 6 |
| Tool calls per question | 8 (a round that would go past 8 is not run) |
| Tool calls running at once | 3 |
| Time per question | 20 s for everything. The loop stops waiting at 20 s; a database query that is already running is not cancelled |
| Size of one request to the model | 32 KB (bytes, checked before each request) |
| Size of one tool result | 8 KB. Lists lose whole items from the end and say they are truncated |
| Orders per `get_my_orders` / items per menu | 10 (with `hasMore`) / 25 (with `totalItems`) |

### The spending guard

Before every request to the model the loop estimates its cost and refuses to send it if the estimate does not fit:

- **Input:** every byte of what will be sent (instructions, tool definitions, the question, every tool call and result) counts as a token, plus fixed overheads, times `ASSIST_ESTIMATE_MARGIN`. Tokenizers usually produce fewer tokens than bytes, so this usually over-estimates. It is an estimate, not a guarantee.
- **Output:** the full `ASSIST_MAX_OUTPUT_TOKENS`, which is also sent as the cap on every request.
- **Price:** input and output separately, from the row for your provider and model in `apps/api/src/llm/pricing.ts` (USD per million tokens, with its tier, source and date). If you use a different model or deployment type, add a row there. A provider and model with no row means nothing is sent.

| Setting | Default | What it limits |
|---|---|---|
| `ASSIST_TURN_BUDGET_USD` | `0.05` | One question |
| `M0_BUDGET_USD` | `5` | Everything ever sent from this checkout, shared with the probe and the evaluation (`.m0-usage.json`) |

After each request the usage the provider reports is **checked before it is written down** (all in `src/assist/budget.ts`):

| What the provider reported | What the ledger does |
|---|---|
| Nothing, or only one of the two figures | Charges the estimate, never zero. Carries on |
| Whole numbers, 0 or more, within this request's own bounds (what the request could possibly have used) | Charges the real usage |
| Not a number, infinite, negative, a fraction, above 1,000,000 input or 100,000 output tokens, or above this request's own bound | **Does not write the figure down.** Charges the estimate that was held for the request, records why on that entry, logs `usage_rejected` or `estimator_violation`, stops the turn, and **blocks every live call** until an operator has looked |

A wrong number is never accounted as if it were true, and an unknown amount is never accounted as zero. While blocked, `/assist/chat` answers
`503 budget_exhausted`, `/assist/intent` falls back as for a budget refusal, and nothing is sent to the provider. The ledger never lifts a block
by itself: not on restart, and not when the cap is reached. If you see `estimator_violation` for a request that was really that large, raise
`ASSIST_ESTIMATE_MARGIN` after you have checked it.

A ledger file that cannot be read, or whose figures are not sane (invalid JSON, a negative cost, an unknown reservation state), is not treated as empty.
Every spending path refuses (`budget: the ledger file ... is corrupt`) and the file is left exactly as it was.

This guard protects this app's budget. It is not a promise about your bill, so also set a budget on your Azure subscription.
The ledger file is safe for any number of processes on one machine; it is not shared between machines.

### Ledger recovery (a block, or a corrupt file)

Everything here is done by a person, with a reason, and keeps what it found. The application never does any of it.

```bash
pnpm budget:status          # spent, committed, BLOCKED since when and why, or CORRUPT
```

**Blocked** (`BLOCKED since ...: usage_rejected:...`). A usage figure from the provider was wrong. The request was charged at its estimate and
live calls stopped. Before you lift it:

1. Look up what the provider really charged for that time (Foundry resource, **Monitoring**, **Metrics**, or Cost Management). Keep a note of what you saw.
2. If the real cost is higher than the estimate that was charged, settle the difference by running `pnpm budget:status` and `pnpm budget:reservations`, and
   consider lowering `M0_BUDGET_USD` for the rest of the run: the ledger cannot add a charge by itself that you have not established.
3. Lift the block, with a reason and an explicit confirmation:

```bash
pnpm budget:clear-halt -- --reason "Checked Foundry metrics for 12 Oct 14:02-14:05: 1,180 in / 96 out, matches the estimate" --confirm
```

This first saves a byte-for-byte copy of the ledger next to it (`.m0-usage.json.evidence-halt-cleared-<time>`, never overwritten), then removes only the block.
The spending record is not changed, and the ledger's `events` list keeps the block, your reason and your user name.

**Corrupt** (`CORRUPT: the ledger file ... is corrupt`). The file is not changed by anything. Do not edit it by hand and do not delete it: you would forget what was spent.

1. Read the file (`cat .m0-usage.json`), and find the real total spent in your provider's billing.
2. Start a new ledger from that figure. The corrupt file is moved aside and kept:

```bash
pnpm budget:start-over -- --baseline-spent-usd 1.37 --reason "File was truncated by a disk-full error; Foundry billing shows 1.37 USD" --confirm
```

There is no default baseline: `0` must be typed, and only if the provider's billing really shows nothing. The new ledger starts with one entry,
`operator-baseline`, and a `restarted_from_corrupt` event pointing at the preserved file.

The $5 cap is a spending guard for this app, not a promise about your bill: requests that are in flight together are each reserved before they are sent,
but the provider can still bill a request whose answer was never received, and an unreadable ledger means nothing can be said about what was spent
until you establish it. Also set a budget on your Azure subscription.

### A request that was sent but never charged

Each request holds its estimate in the ledger from just before it is sent until its usage is charged. If the API stops in
between (a crash, or you close the terminal at the wrong moment), the request may still have been processed and billed, so the
hold stays when you restart, and `pnpm dev` prints `budget: 1 sent request(s) were never settled and stay held`. To clear it:

```bash
pnpm budget:reservations                                   # lists them: id, time, held amount
pnpm budget:settle -- <id> --tokens <input>/<output>      # charge what Azure reports for that time
pnpm budget:settle -- <id> --estimate                      # or charge the amount already held
```

Find the real token counts in the Azure portal: open your Foundry resource, then **Monitoring**, then **Metrics**, and look
at the input and output token metrics around that time. Each hold can be settled once; a second settle is refused. There is
no command that sets a sent request to zero.

## 8. Traces in Jaeger

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

## 9. Resetting state

| You want | Do this | Note |
|---|---|---|
| Fresh database | `pnpm db:seed` | Wipes and re-creates all data |
| Fresh fake provider | Restart `pnpm dev` | Its charges and idempotency keys live in memory |
| A clean demo | Both of the above | **Seeding alone is not enough**: the provider still remembers a key from a previous payment and replays that result |
| Everything gone | `docker compose --profile observability down -v` | `-v` also deletes the database volume |

## 10. Tests

```bash
pnpm typecheck     # TypeScript, both apps
pnpm test          # needs the postgres container; drops and re-creates a separate tadka_test database
```

Expected: 13 fake-provider tests, 356 API tests and 35 web tests pass. Your dev database is never touched. A few API and fake-provider tests start the real server process with the command from the app's `package.json` and stop it with SIGTERM, so they take several seconds.

| File | What it proves |
|---|---|
| `access-tokens.test.ts` (9) | No token, bad signature, expired, wrong issuer, wrong audience, wrong algorithm, wrong type all return 401; a valid token returns 200 |
| `refresh-tokens.test.ts` (9) | Rotation, reuse detection, concurrent refresh, logout, expiry, only a hash is stored |
| `orders.test.ts` (6) | Customers see only their orders, other people's orders return 404, owners see no address, admins see all, the state machine rejects bad moves |
| `payments.test.ts` (5) | Cross-user payment is refused, timeout is resolved by lookup, error then retry charges once, paying twice is a no-op, the money constraint |
| `triage.test.ts` (6) | The LLM call returns a typed object, rejects a bad shape and passes the adapter's options through untouched; the budget guard refuses before sending; a provider and model with no price is refused, even if another provider has one; every price row names its source and date |
| `llm-config.test.ts` (8) | Provider selection: `LLM_PROVIDER` decides; an explicit provider without credentials is an error that names variables, never values; Azure-only settings still work, with a warning; both providers present and no choice is refused; the Azure deployment name is kept apart from the model we price |
| `llm-contract.test.ts` (18) | The same checks once per provider, using the real factory and the real AI SDK with a recording stand-in for the network: correct address and credentials, no provider-side storage, no reasoning tokens, the output cap, temperature 0, structured output, no ignored settings, reasoning tokens charged once; a deployment name the SDK would not recognise is refused |
| `llm-boundary.test.ts` (6) | Only `src/llm` imports a vendor SDK, builds a provider client or builds provider option objects; scripts get their model from the same factory |
| `assist-order-status.test.ts` (4) | The no-LLM route: own order, someone else's is 404, no token is 401, a bad id is 400 |
| `intent-rules.test.ts` (6) | The five-label schema rejects unknown labels and extra fields; the keyword rules, their documented blind spot (negation) and the dev set |
| `intent-classifier.test.ts` (6) | Each outcome with a fake provider: ok, a valid `other`, invalid output (five shapes), refusal, provider errors; no retry; the cost guards are sent |
| `assist-intent.test.ts` (11) | Customers only, no identity in the body, one/several/no active orders, a failing lookup is a 500, labels that must not act change nothing in the database, fallbacks per outcome, rules by default |
| `intent-eval.test.ts` (18) | The frozen set (size, labels, no overlap with the dev set), **both frozen files pinned by SHA-256**, the rules' stable score, the new metrics (per-intent precision and recall, failure rates, latency percentiles, paired comparison) against hand-computed values, and the budget guard stopping before it sends |
| `assist-intent-hardening.test.ts` (21) | `/assist/intent` against a fake provider that throws, hangs or answers badly, through the real classifier, route, limiter and logger: the timeout cuts a hung call off and the model sees the abort; the per-user limit (own quota, rejected requests use none); demo mode never calls the classifier; invalid and refused output; provider errors (401, 403, 429, 500, network, unexpected) with safe, useful logs and no retry |
| `intent-startup.test.ts` (4) | The real process and `/assist/intent`: with a provider that RECORDS requests, demo mode with credentials makes zero provider calls (and a control shows the recorder catches a call outside demo mode); the template as copied answers from the keyword rules; a half-chosen provider still refuses to start |
| `boundaries.test.ts` (6) | `assist` and its tools import only the public orders and restaurants services, nothing in `src` imports the demo, and no model output or tool schema has a field that can name a user |
| `naive-tool-demo.test.ts` (2) | The naive tool leaks Aman's address into Rahul's chat; the real tool returns `not_found` |
| `assist-reads.test.ts` (5) | Recent orders are newest first with a fixed tie-break, capped, with `hasMore`; a foreign order and an invented id give the same error and the same HTTP 404, and only an internal flag tells them apart; the menu is capped in a fixed order |
| `tool-executor.test.ts` (10) | Allow-listed fields only; unknown tool, unparsable input, an extra `userId` and a bad id are `invalid_args` with no side effect; a tool not offered to the role looks like an unknown tool; a backend failure is `failed`; ordinary logs are identical for a foreign and an invented id while only the audit log records the difference; the result size cap |
| `budget-safeguards.test.ts` (33) | Usage validation (NaN, infinite, negative, fractional, above the bounds), a rejected figure charged at the estimate and blocking live calls, the block surviving restart, the cap, concurrent reservations, every kind of corrupt file refused and left untouched, and the operator recovery (reason and confirmation required, evidence kept, nothing reset without a baseline) |
| `budget-ledger.test.ts` (5) | Separate processes cannot reserve the same allowance; a crash after sending keeps the hold through a restart; a settle applies once, even when two run at the same time; released or unpriced is refused; a half-written temp file is harmless |
| `agent-loop.test.ts` (51) | Multi-step answers from templates, model prose never shown, one result per call id when parallel calls finish out of order, partial failure, at most 3 at once, each limit on its own, the deadline for a slow tool and a slow model, the output cap on every request, every budget rule, the payload cap separate from the budget, no retry and no tool re-run after a provider error |
| `assist-chat-failures.test.ts` (13) | `POST /assist/chat`: provider 429/401/500/503/timeout, prose, looping, database failure and the cap are 429/502/503/504 with a code, the fallback sentence and nothing from the provider; the per-user rate limit (401/403 use no quota, another user unaffected, a limited request never reaches the provider); an aborted HTTP request abandons the provider call; demo mode never calls the model |
| `assist-chat.test.ts` (5) | `POST /assist/chat` end to end: own orders, Aman's order in Rahul's chat is not found with one audit event, an invented id, customers only, 503 without a model |
| `cors-and-assist.test.ts` (8) | CORS preflight and exposed headers; a disallowed origin gets no CORS headers and no 500; the triage route's 401, 400, 200 and 503 |
| `guard.test.ts` (7) | The shared guard for model-spending routes on a bare app: 401/403 never use quota, the limit is per verified user, each route has its own quota, Retry-After, the timeout signal |
| `provider-mode.test.ts` (5) | The startup decision: demo never initialises the provider, live, off, and a chosen-but-incomplete provider is refused |
| `assist-errors.test.ts` (15) | Provider failures (401, 403, 429, 500, 404, network, 504, bad output) become our own status and code; provider text, keys, resource names and the customer's message never reach the response or the log; a provider auth failure is not a 401; a hung call is cut off at the timeout and the model sees the abort |
| `assist-access.test.ts` (15) | Only customers may call triage (401 / 403 `forbidden_role`; the role comes from the verified token); the rate limit is per verified user and does not count rejected requests; `simulated` is explicit; `DEMO_MODE` and limit settings are parsed strictly |
| `startup.test.ts` (19) | The real server process, started with the command from `package.json`: from the parsed `.env.example` as copied (model off, honest 503), with `DEMO_MODE=1`, with a half-filled provider in demo mode (still starts), and the live refusals (provider chosen without its key, unknown provider, bad deployment name, bad numeric setting): exit code 1, one line, no stack trace, no credential value |
| `shutdown.test.ts` (20) | The shutdown sequence (order, a failing stage, a hang in each stage position, a stage finishing after the deadline, repeated signals, the root `--no-bail` setting) and the real process with telemetry off, on and refused, with a server close stuck on an unfinished request, and with a trace backend that never answers |
| `fake-psp/test/shutdown.test.ts` (5) | The same shutdown contract for the fake provider |
| `web/test/*.test.ts(x)` (35) | The client: demo sign-in on and off, the SIMULATED badge, error wording per code, malformed responses, cancel, client timeout, the token is sent only when there is one |
| `fake-psp/test/idempotency.test.ts` (8) | Key required, replay, key reuse with a different body, concurrent requests, timed-out and errored charges, final declines, refund cap |

## 11. The LLM probe

```bash
pnpm probe:llm                 # dry run: a fake model, no key, no network, no cost
pnpm probe:llm -- --live       # ONE real call to the series model (gpt-5.4-mini) on the provider LLM_PROVIDER names
```

The dry run prints a typed answer (`intent`, `language`, `needsHuman`, `summary`) from a fake model. It proves the
code path and the schema, not the provider.

### The assist endpoint: modes, limits, errors, shutdown

`POST /assist/triage` (the route the browser uses):

| Situation | Answer |
|---|---|
| No token | `401 missing_token` or `invalid_token` |
| Signed in as an owner or admin | `403 forbidden_role` (customers only; the role comes from the signed token, never from the request body) |
| More than `TRIAGE_RATE_LIMIT_PER_MIN` requests in a minute from one user | `429 rate_limited` with `Retry-After`. Other users are not affected |
| No provider configured and `DEMO_MODE` off | `503 provider_not_configured` |
| `DEMO_MODE=1` | `200` with `simulated: true`, `modelId: "demo-mock"`. No model is called |
| Real provider answers | `200` with `simulated: false` and the model name the provider reported |
| Provider rejects the key or permission | `502 provider_auth` (this is **not** a 401: the caller's own sign-in was fine) |
| Provider is rate limiting us | `429 provider_rate_limited` |
| Provider down, network failure, any other provider error | `502 provider_unavailable` |
| Provider does not answer within `TRIAGE_TIMEOUT_MS` | `504 provider_timeout`; the call is aborted |
| Provider answered with something that is not valid triage JSON | `502 provider_bad_output` |

The error text is always ours. Provider messages, keys, resource names and the customer's message are not in the response or in the log
(the log keeps the error class, the provider's status number and our code).

What the limits are, and are not:
- The rate limit is basic abuse protection. It lives in the API process's memory, so it resets on restart and is not shared between several instances.
- **The `M0_BUDGET_USD` ledger does not apply to `/assist/triage`.** It guards `pnpm probe:llm -- --live`, `pnpm eval:intent --live` and the LLM classifier behind `/assist/intent` (section 6). Triage is bounded by the rate limit, the 500-character input, the 400-token output cap and `maxRetries: 0`; there is no hard money cap on it.
- **The ledger can under-count.** It adds a call's cost only when the provider reports usage. A call that times out or fails without a usage report is not added, so the ledger is not a hard cap; the provider's own spending limit is.
- The timeout aborts the call at the AI SDK / `fetch` boundary (proved against a stand-in for the network). Whether a live Foundry request is cancelled on the provider's side has not been checked.

Stopping the servers is bounded: the API and the fake provider stop accepting requests, close the database (API only),
flush traces for up to 3 seconds, and exit. The whole sequence has an 8 second deadline (`SHUTDOWN_DEADLINE_MS`); after that the process is
forced to exit with code 1, whichever step is stuck. **A request still running at the deadline is abandoned.** Exit code 0 means every step finished;
1 means a step failed or the deadline hit (for example when the trace backend is down). A second signal does not start a second shutdown.

Which way of starting and stopping gives you that:

| How it was started, and how it is stopped | Graceful shutdown? |
|---|---|
| `pnpm dev`, then **Ctrl+C** in that terminal | **Yes** for the API and the fake provider. Checked with the trace backend unreachable: both closed the server (and the API its database), tried the trace flush, and exited in about 5 s. pnpm itself then ends with `ERR_PNPM_RECURSIVE_FAIL` because the Vite dev server exits with a failure code on Ctrl+C; that is harmless. The root `dev` script uses `--no-bail` for this: without it pnpm kills the other apps as soon as Vite exits. The trade-off: if one app crashes at start, the others keep running until you press Ctrl+C. A successful trace flush to a running Jaeger has **not** been checked through this command |
| The `node …` command from an app's `dev` or `start` script (`node --env-file-if-exists=../../.env --import tsx --import ./src/instrument.ts src/main.ts`) run directly, then SIGTERM or SIGINT to that node process | **Yes.** This is what the automated shutdown tests run |
| SIGTERM sent to a `pnpm` process: `kill <pid of pnpm>`, `docker stop` or a CI cancel where pnpm is the main process, for `pnpm dev`, `pnpm --filter … dev` or `pnpm exec node …` | **No.** pnpm 12.11.2 does not pass SIGTERM to the apps it started, and they keep running (checked for all three). In a container or under a process manager, run the `node …` command directly |
| SIGKILL, power loss | No, by definition |

### Switch provider

The probe, and everything built on it in later branches, asks `apps/api/src/llm` for its model. Provider choice is configuration only:

| You want | Put in `.env` |
|---|---|
| Microsoft Foundry (the series default) | `LLM_PROVIDER=azure`, `AZURE_RESOURCE_NAME`, `AZURE_API_KEY`, `AZURE_DEPLOYMENT` |
| The direct OpenAI API | `LLM_PROVIDER=openai`, `OPENAI_API_KEY` |

Rules the module enforces, each tested:

- **Choose explicitly.** With `LLM_PROVIDER` unset, Azure settings alone still work but print a warning; if both Azure and OpenAI settings are present and `LLM_PROVIDER` is unset, it refuses to guess. An `OPENAI_API_KEY` alone never selects OpenAI.
- **The two protections follow the provider.** Both adapters send `store: false` (no provider-side storage) and no reasoning tokens, each under that provider's own option name. The adapter contract tests check the request each one really sends.
- **Prices follow the provider.** The budget looks up `provider:model` (`azure:gpt-5.4-mini`). There is no price row for `openai` yet, so `LLM_PROVIDER=openai pnpm probe:llm -- --live` stops with `Nothing was sent` until you add one in `apps/api/src/llm/pricing.ts` from OpenAI's price list, with its source and today's date. Do not reuse Foundry's numbers without checking them.
- **Deployment name is not model name.** The model we price and evaluate is `LLM_MODEL`. On Azure, `AZURE_DEPLOYMENT` is only the name of your deployment, and it must be named like a GPT model (`gpt-5.4-mini`, `gpt-5.4-mini-1`): the AI SDK reads the name to decide the model supports the reasoning setting, and a name such as `my-deployment` is refused.

Same code, different provider does not mean the same behaviour. Structured output, token counts and error text can differ, so run your own checks on the provider you switch to.

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

A good run prints JSON with `"mode": "live"`, your `model` and the price row it used (`pricedAs`), a typed `output` (`intent`, `language`, `needsHuman`, `summary`),
`latencyMs`, token `usage`, and `costUsd`. If it fails:

| Message or symptom | Likely cause | Fix |
|---|---|---|
| `Startup refused: LLM_PROVIDER=azure needs AZURE_RESOURCE_NAME and AZURE_API_KEY` | You chose a provider but a credential is empty, or `.env` is not in the repository root | Fill both and run again from the repository root; or empty `LLM_PROVIDER` to run without a model (add `DEMO_MODE=1` for simulated answers) |
| `AZURE_DEPLOYMENT "..." is not named like a GPT model` | The deployment has a name the AI SDK cannot recognise | Create or choose a deployment named like `gpt-5.4-mini` |
| `Nothing was sent. budget: no price configured for ...` | This provider and model have no price row | Add one in `apps/api/src/llm/pricing.ts` (section 11, Switch provider) |
| 401 (access denied) | Wrong or regenerated key | Copy KEY 1 again |
| 404 or `DeploymentNotFound` | `AZURE_DEPLOYMENT` does not match the deployment name | Copy the name exactly from the **Deployments** list |
| `ENOTFOUND` or a connection error | `AZURE_RESOURCE_NAME` is wrong (for example the full URL) | Use only the name before the first dot |
| An error about `reasoningEffort` | The deployment does not accept `none` | Change `reasoningEffort` to `'low'` in `apps/api/src/llm/azure.ts` and remove the `temperature` line in `apps/api/src/assist/triage.ts` |

What the live call does, and why:

| Setting | Why |
|---|---|
| One synthetic Hinglish message | No real customer data leaves your machine |
| `reasoningEffort: 'none'` (set by the adapter) | A classification does not need reasoning tokens, which are billed as output |
| `maxOutputTokens: 400`, `maxRetries: 0` | A hard ceiling per call, and no silent retries that spend money |
| `store: false` | The Responses API keeps responses by default; this asks it not to |
| Budget ledger `.m0-usage.json` | Before sending, the probe adds the worst-case cost of this call to what you have spent. If that would pass `M0_BUDGET_USD` (default 5), it refuses and sends nothing |

It prints the model and deployment, the price row it used, any warning the SDK raised about a setting it could not apply, latency, token usage and cost. One call costs a fraction of a cent. Also set a budget alert on
your Azure resource group (not required to run the branch): an alert only notifies, while the ledger is what stops the call.

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm db:migrate` fails right after `docker compose up` | Postgres was not ready yet | Use `up -d --wait`, or wait a few seconds and re-run |
| `container name ... is already in use` | A stack from another checkout uses the same fixed container names | `docker compose down -v` in that other checkout, or `docker rm -f tadka-ai-postgres tadka-ai-jaeger` |
| `EADDRINUSE` on 3000 or 4010 | A previous `pnpm dev` is still running, or another program uses the port | Stop the old process, then start again. On Windows PowerShell: `Get-NetTCPConnection -LocalPort 3000 \| Select-Object OwningProcess` shows the process id, then `Stop-Process -Id <id> -Force`. In Git Bash: `netstat -ano \| findstr :3000`, then `taskkill //PID <id> //F` (the double slashes are needed in Git Bash) |
| `docker: error during connect` or `failed to connect to the docker API` | Docker is not running | Start Docker Desktop and wait until it says Docker is running |
| `command not found` or `is not recognized` for `pnpm`, `node`, `jq` or `docker` | The program is not installed, or the terminal was opened before it was installed | Open a new terminal, then check with the list at the end of section 2 |
| `pnpm dev` says `classifier: keyword rules` but you expected the LLM | The provider settings are empty in `.env` (the log line says what is missing), or `.env` is not in the repository root | Set `LLM_PROVIDER` and its credentials, then restart `pnpm dev` (section 4) |
| `pnpm dev` exits with `LLM_PROVIDER=... needs ...` or `Both Azure and OpenAI settings are present` | The provider choice is incomplete or ambiguous | Fix `.env` as the message says, or clear the LLM settings to use the keyword rules |
| `POST /assist/intent` returns `{"error":"assistant_unavailable"} [502]` | The model call failed: wrong key or deployment name, quota, a timeout, network, or the spending guard refused | Read the server log line `assist/intent: no intent was produced`: its `reason` and `providerStatus` say which. Then check the provider settings in `.env`, `.m0-usage.json` against `M0_BUDGET_USD`, and try `pnpm probe:llm -- --live` |
| `pnpm eval:intent --live` ends with `budget_stop` rows | A run or ledger cap would have been crossed, so the remaining requests were not sent | Raise `EVAL_BUDGET_USD` or `M0_BUDGET_USD` on purpose, or delete nothing and read the totals in the output |
| `POST /assist/chat` returns `{"error":"assistant_not_configured"} [503]` | No model is configured | Fill the credentials for your `LLM_PROVIDER` in `.env`, then restart `pnpm dev` (section 11) |
| `POST /assist/chat` always answers `503` with `"error":"budget_exhausted"` | The question's estimate is over `ASSIST_TURN_BUDGET_USD`, the ledger is near `M0_BUDGET_USD`, or your provider and model have no price row | Check those three settings, and `pnpm budget:status` for a BLOCKED or CORRUPT ledger (section 7, Ledger recovery); `pnpm budget:reservations` shows what is spent and held |
| `POST /assist/chat` answers `502`, `504` or `429` with `"stopReason":"provider_error"` (or `deadline`) | Wrong key or deployment name, quota, or network | Try `pnpm probe:llm -- --live` first (section 11) |
| `budget: ... sent request(s) were never settled` when `pnpm dev` starts | The API stopped between sending a request and charging it | Settle them as described in section 7 |
| `Unsupported engine` or a Node error | Wrong Node version | `node -v` must print v24 or v26; install Node 24 (section 2) |
| `corepack` is not recognized | Node 25 and later no longer include corepack | Skip corepack and run `npm install -g pnpm@12.11.2` |
| Everything returns 401 after a restart | The dev signing key is regenerated on every start | Log in again |
| Pay ignores the lever you set | The order was already paid or declined. After a re-seed the provider still replays its stored result for that order's key | Restart `pnpm dev` after `pnpm db:seed` (section 9) |
| `LLM_PROVIDER=azure needs AZURE_...` (a message that names variables) | `--live` without that provider's credentials | Fill them in `.env` (section 11) |
| No traces in Jaeger | Jaeger is not running, or `OTEL_EXPORTER_OTLP_ENDPOINT` is empty | Start with `--profile observability`; check `.env` |
| PowerShell prints `ConvertFrom-Json : Cannot bind argument to parameter 'InputObject' because it is null` and `[0]` | The `Call` helper from an older copy of this runbook sent a body with GET requests, which Windows PowerShell 5.1 refuses | Paste the `Call` and `Login` helpers from section 5 again |
| The browser says "No AI model is configured on the server" (`503 provider_not_configured`) | No provider credentials, and `DEMO_MODE` is off | Add credentials (section 10), or set `DEMO_MODE=1` in `.env` and restart |
| The page says "Not signed in. The demo sign-in is switched off" | The client was built without `VITE_DEMO_LOGIN=1` (a production build) | Use `pnpm dev`, or build with `VITE_DEMO_LOGIN=1` |
| The page says "This build has no API address" | A production build was made without `VITE_API_URL` | Rebuild with `VITE_API_URL` set to the API's address (for local use `http://localhost:3000`) |
| `DEMO_MODE must be "1" or "0"` at start | `DEMO_MODE` has another value (`true`, `yes`) | Use `1`, `0` or leave it empty |
| `429 rate_limited` | More than `TRIAGE_RATE_LIMIT_PER_MIN` requests in a minute | Wait for `Retry-After` seconds |
| Tests fail to connect | The postgres container is not running | `docker compose up -d --wait` |

## 13. Teardown

```bash
# Ctrl+C in the pnpm dev terminal, then:
docker compose --profile observability down -v
```

The same two steps work in PowerShell.

This removes both containers, the network and the database volume.
