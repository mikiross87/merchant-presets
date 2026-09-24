# #96 spike: buying through the GM's `User#query`

Run on 2026-09-24 against Foundry 14.368 and dnd5e 6.0.5, headless: one server on :30001 with an isolated data path, and Playwright clients as separate browser contexts (one socket each). World: users Gamemaster, P1 and P2, characters C1 (P1) and C2 (P2) with 20 gp each, and General Store (Town) imported from this module's pack with `ownership.default` set to Limited. `buy.mjs` is the handler; `run.mjs`, `race.mjs`, `tabs.mjs` and `dup.mjs` are the probes; `results/` holds their raw output.

Source read first (`client/documents/user.mjs:289`, `client/documents/collections/users.mjs:219`, `dist/components/activity.mjs`). The server forwards a query to **every socket** of the target user. It listens for `disconnect` on the **sender's** socket only. And the `QUERY_USER` permission defaults to Player.

## Answers

**Q1: Limited permission.** The player's client holds the whole actor: all 57 items, `system.currency`, and every flag, including a GM-only `dealNotes` flag set for the probe and all 20 `item-piles` data keys (`run2.log`, Q1). A direct `merchant.update()` from the player is refused. → #111: GM-only deal data must not live on the merchant actor.

**Buying works.** P1 bought one Bell for 1 gp: the Bell landed on C1, C1 went 20 → 19 gp, stock 11 → 10, and the till 250 → 251 gp. The player's own view matched (`run1.log`).

**Q2: two buyers, last item.** Without a queue, both P1 and P2 bought the last Bell. Stock went to 0, not −1, both paid 1 gp, and the till gained only 1 gp: a duplicated item and a lost update (`race.log`). With the GM client running trades one at a time through a promise chain, P2 got it and P1 got "Only 0 Bell left". → #102 must serialise trades on the GM client.

**Q2b: the GM has two tabs open.** Both tabs ran the handler for one purchase. Stock and coin moved once, because both tabs wrote the same absolute values, but C1 received **two** Bells 107 ms apart (`tabs.log`). Using the trade's chat message as a lock (create with a fixed `_id`) does not stop it: in V14, a create with an existing id and `keepId` **overwrites** instead of failing, sequentially and concurrently alike (`dup.log`, `tabs2.log`, `tabs3.log`). → #102 needs to elect one GM tab to handle trades. Candidates: the last-opened tab claims it through a user flag, and the other tabs never answer (the server acks whichever answers first).

**Q3: no GM connected.** `game.users.activeGM` is `null` and querying the GM user throws "User [id] is not active" immediately: a clear refusal, no hang (`run2.log`, Q3). The code has to guard the `null`.

**Q3b: the GM disconnects mid-trade.** With no timeout, the player's promise was **still pending after 15 s** and would never settle: the server only watches the sender's socket for disconnects. → Always pass a `timeout`.

**Q4: a slow GM.** With a 3 s handler and a 1 s timeout, the player got "operation has timed out" at 1.07 s, **but the trade still went through** afterwards. At +3 s the Bell and the charge had landed while the till was not yet credited, which shows the four writes are not atomic. → A timeout means "unconfirmed", not "failed". The client should reconcile through the trade's id (e.g. its chat record), and #102 should cut the four writes to one update per actor.

## Verdict

**Go**, with four constraints for #102: serialise trades on the GM client, elect one GM tab, always pass a query timeout and treat it as unconfirmed, and guard `activeGM === null`. None of them needs Item Piles.

Harness note: the most recently joined headless client lags several seconds behind `game.ready` while it finishes loading, so the probes let clients settle for 15 s before racing them.
