# Sidepool — multiplayer prototype

A public, multi-user recreation of the "Versus" pooled binary-betting
mechanic: everyone who has the page open shares the same live round.
Players pick Side A or Side B, stakes pool up (you can add to your stake
more than once per round, as long as you stay on the side you first
picked), and when the round locks the whole pool splits among the
winning side proportional to stake — no fixed odds. The winner is
decided by **momentum**: whichever side is holding the larger total pool
the instant betting locks wins; a tie (or a round nobody bet in) has no
majority and voids, refunding every stake. Balances are shown as
"USDT" for realism, but every unit is entirely virtual (free top-ups) —
**there is no real money, payment processing, or crypto in this
build.**

This is a real Node.js app (Express + WebSocket), not a static page — it
needs to run on a server somewhere so a shared link works for anyone. It
does not use the Claude Artifact platform at all, because that platform's
live-data feature only works for people signed in to the same
organization; this is meant for a public link instead.

## How it works

- `server.js` runs one authoritative game loop (open → locked → reveal →
  next round, ~20s cycle) and pushes state to every connected browser
  over a WebSocket at `/ws`.
- **Identity is the connected wallet address** — the same pattern the
  original site uses. There's no signup form and no password:
  1. The browser asks `window.ethereum` (MetaMask or any other injected
     wallet) for the connected account.
  2. The server hands back a one-time message to sign
     (`GET /api/nonce`) — plain-language "sign-in with Ethereum" text
     that explicitly says no transaction will be sent and no funds move.
  3. The wallet signs it (`personal_sign` — free, no gas, no on-chain
     transaction) and the browser posts the signature to
     `POST /api/verify`.
  4. The server recovers the signing address from the signature (via
     `ethers.verifyMessage`) and checks it matches the address that
     asked for the nonce. A match proves wallet ownership; the nonce is
     then deleted so it can't be replayed.
  5. On success the server creates/looks up a player record keyed by
     that address and returns a short-lived session token, which the
     browser stores in `localStorage` and presents on future WebSocket
     connections (`{type:"hello", token}`) so people aren't asked to
     re-sign on every page load.
  - This proves *control of the address*, nothing more — no balance
    check, no chain interaction, no funds ever move. It's the same
    "connect wallet, sign a free message" pattern real dApps use for
    login, deliberately kept separate from any actual wagering logic.
  - Only injected browser-extension wallets (MetaMask, Coinbase Wallet,
    Rabby, Brave Wallet, etc. — anything that sets `window.ethereum`)
    are wired up. Mobile-wallet QR connections need WalletConnect,
    which requires signing up for a free project ID at
    [cloud.reown.com](https://cloud.reown.com) and pulling in their SDK —
    left out for now since it needs an account only you can create; the
    `connectWallet()` function in `public/app.js` is the place to add it.
  - Session tokens live in memory (`sessions` map in `server.js`) — a
    server restart signs everyone out and they just reconnect + re-sign,
    a few seconds of friction, not a data loss.
- Player balances and round history are kept in memory and written to
  `data/state.json` every ~15s so a restart doesn't wipe everyone's
  balance. On most free hosting tiers this disk is **ephemeral** — wiped
  on redeploy and sometimes on restart. See "Making data durable" below.
- A handful of simulated "bot" bettors keep the pool moving even when
  only one or two real people are online — cosmetic only, they don't
  have wallets or take a cut.

## Run it locally

```
npm install
npm start
```

Then open `http://localhost:3000`. Open the same URL in a second browser
tab (or incognito window) with a different name to see two players share
a live round.

## Going live on your own domain

This walks through Render.com end to end — GitHub push → live URL →
custom domain → HTTPS. It's the fastest path to a real `https://` link,
handles WebSockets with no extra config, and its custom-domain flow is
verified current as of writing. Option B below is the equivalent path
for a VPS or any other Docker host if you'd rather not use Render.

### Part 1 — Get the code onto GitHub

Render deploys from a git repo, so push this folder there first.

```
cd sidepool-server
git init
git add .
git commit -m "Initial commit"
```

Create a new **empty** repo on GitHub (github.com → New repository —
don't initialize it with a README, or the next push will conflict),
then:

```
git remote add origin https://github.com/<your-username>/sidepool-server.git
git branch -M main
git push -u origin main
```

### Part 2 — Deploy it on Render

1. Sign up / log in at [render.com](https://render.com) — signing in
   with GitHub makes the next step one click.
2. **New +** → **Web Service**.
3. Connect your GitHub account if you haven't, and select the
   `sidepool-server` repo.
4. Render auto-detects the `Dockerfile` in this repo and sets the
   runtime to Docker. Leave it as-is.
5. Give it a name (this becomes part of the temporary URL), pick a
   region near your players, and pick an **Instance Type**:
   - **Free** works to try it out, but spins the service down after 15
     minutes with no traffic (the next visitor waits ~1 minute for it
     to wake back up) — fine for testing with friends, not for
     something you want live 24/7.
   - A paid **always-on** instance type keeps the round clock ticking
     continuously and skips that cold start — worth it once you're
     sharing the link for real. Check Render's pricing page for current
     rates, since these change.
   No environment variables are needed — Render injects `PORT` itself
   and `server.js` already reads `process.env.PORT`.
6. **Create Web Service**. The build takes a minute or two — watch the
   deploy log for `Sidepool server listening on port ...`.
7. Render gives you `https://<your-service-name>.onrender.com`. Open
   it, connect a wallet, place a bet — confirm it works before moving
   on to the domain.

### Part 3 — Point your domain at it

1. In the service, go to **Settings → Custom Domains → + Add Custom
   Domain**, and enter the domain or subdomain you want (e.g.
   `bet.yourdomain.com`, or the bare `yourdomain.com`).
2. Render shows you the exact DNS record to add — copy it exactly, it's
   specific to your service:
   - **Subdomain** (`bet.yourdomain.com`): add a **CNAME** record at
     your DNS provider with host `bet` pointing at the target Render
     shows (your `....onrender.com` hostname). This is the simpler
     option — use it if you have the choice.
   - **Apex/root domain** (`yourdomain.com` with nothing in front):
     plain CNAMEs aren't allowed at the root by DNS rules, so use
     whatever your DNS provider calls its root-domain workaround —
     **ALIAS**, **ANAME**, or "CNAME flattening" (Cloudflare, DNSimple,
     and most modern providers have one). If yours doesn't, make `www`
     the canonical link instead and redirect the root to it.
   - Delete any existing `AAAA` record on that name — Render serves
     over IPv4 only, and a leftover `AAAA` record will break
     verification.
3. Back in Render's Custom Domains panel, click **Verify**. DNS changes
   can take anywhere from a couple of minutes to a few hours to
   propagate — if verification fails immediately, wait and retry rather
   than changing the record again.
4. Once verified, Render automatically issues a free TLS certificate
   and redirects plain `http://` to `https://` — nothing to configure.
5. Visit `https://yourdomain.com`. Open it on two devices (or a normal
   window + a private one) and confirm you see the same live round on
   both — that's confirming the WebSocket connection works over your
   domain too, since it rides the same `https`/`wss` connection with no
   separate setup.

### Option B — Any VPS or other Docker host

```
docker build -t sidepool .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name sidepool sidepool
```

Point an **A record** at your server's IP, then put a reverse proxy in
front for HTTPS and the domain — Caddy is the easiest: point it at your
domain and `reverse_proxy localhost:3000`, and it gets a certificate and
passes WebSocket upgrades through automatically, no extra config. nginx
works too but needs two explicit `proxy_set_header` lines for the
`Upgrade`/`Connection` headers or WebSocket connections will fail.

Railway, Fly.io, and most other "point at a Dockerfile" hosts follow
essentially the same shape as the Render steps above: connect the repo,
deploy, add the custom domain in their dashboard, add the DNS record
they show you.

## Making data durable

The default JSON-file store is fine for a demo but will lose data on a
redeploy on most platforms, and it doesn't scale past one server
instance. When you're ready to make this sturdier (and especially before
the real-crypto version), swap the `loadState`/`saveState` functions in
`server.js` for a real database (Postgres, Redis, etc.) — the rest of the
game logic doesn't need to change, since it only touches `players`,
`history`, and `roundCounter` through those two functions plus the
in-memory `Map`.

## Known limitations (by design, for this prototype stage)

- Wallet connection proves address ownership, nothing else — it doesn't
  check chain, balance, or ENS name, and there's no age/jurisdiction
  gate (the original site blocks US users and minors; this prototype
  doesn't block anyone).
- Sessions are a plain in-memory token with no rotation/refresh beyond
  its 24h expiry — fine for a prototype, worth hardening (shorter TTL +
  refresh, or JWTs) before anything resembling production.
- Single server instance only — the in-memory game state doesn't
  replicate across multiple instances, so don't put this behind a
  multi-instance autoscaler as-is.
- No rate limiting beyond the top-up cooldown — fine for a prototype
  shared with friends, worth hardening before wider traffic.
- No moderation on nicknames beyond stripping a few characters and a
  length cap.

## Before this becomes real-money

You mentioned the eventual plan is to switch this to the same crypto
setup as the original site, once legal review has cleared specific
jurisdictions. The wallet-connect piece above is the first step of that
— proving who's playing — but treat the rest of this codebase as *game
loop and UI only*: real-money wagering additionally needs a licensed
operator, KYC/age verification, on-chain (not just signed-message)
settlement, audited payout logic, and jurisdiction gating enforced at
connect time (not just stated in a footer), none of which this
prototype has. Worth looping legal review in on the settlement
mechanics themselves — the parimutuel split *and* the momentum-based
winner rule (whichever side holds the bigger pool at lock wins) — too,
not just the payment rail and the login flow. A momentum-decided
outcome is a materially different thing to get legal sign-off on than a
random draw: it's not an independent, verifiable event, and depending on
jurisdiction that distinction can matter a lot for how this gets
classified. If a real stablecoin (USDT or otherwise) gets wired in later,
that's its own separate review — on-chain transfers, custody, and
redemption all need clearing on top of the settlement-logic review
above.
