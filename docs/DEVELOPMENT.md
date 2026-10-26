# Wiser Style Heating: first development slice

The original Hive-style assets and HACS manifest remain unchanged on `main`.
This branch adds an independent Wiser-native schedule editor. It does not install to Home Assistant or touch the existing Heating Demo dashboard.

## Build and test

Node.js 20+:

```sh
npm test
npm run build

# Automated Chromium interaction tests run in GitHub Actions.
# For local browser testing:
npm install --no-save playwright@1.58.2
npx playwright install chromium
node tests/browser-ui.cjs
```

The build concatenates the source core and card into `dist/wiser-native-schedule-card.js`. No dependency download is needed.

## Test the development card in Home Assistant

Copy the built file to `/config/www/wiser-native-schedule-card.js` and add a JavaScript module dashboard resource:

```text
/local/wiser-native-schedule-card.js
```

Then add a manual Lovelace card:

```yaml
type: custom:wiser-hive-schedule-card
title: Heating schedules
demo: true
```

Demo mode uses eight rooms and never calls Wiser. A browser reload resets demonstration edits.

With a commissioned Wiser hub and the Wiser custom integration installed, turn off demo and identify your hub:

```yaml
type: custom:wiser-hive-schedule-card
title: Heating schedules
demo: false
hub: YOUR_WISER_HUB_NAME
```

**Live saves are disabled by default**. The card can display schedules in real mode, but pressing Save will be refused unless you explicitly add `allow_live_writes: true`. This option is **not recommended for production at this stage**.

When testing in a controlled environment after exporting/backing up all existing Wiser schedules, the opt-in is:

```yaml
type: custom:wiser-hive-schedule-card
title: Heating schedules
demo: false
hub: YOUR_WISER_HUB_NAME
allow_live_writes: true
```

The Wiser integration's `wiser/schedule/id` WebSocket command returns its **cached schedule object**; it does not itself refresh the physical hub. Both the pre-save comparison and the readback are therefore comparisons with the integration cache. They can detect changes already observed in HA but **cannot guarantee a recent change made through the Wiser app has been seen**, cannot provide transactional/atomic conditional writes, and cannot rule out an assignment change between the check and the write. The UI warns about this before writing. Do not mistake `allow_live_writes` for a concurrency guarantee.

**Do not enable live saving for your household until a refresh-aware/transactional workflow has been assessed and verified against your exact hub.** The first development version is not production tested on a physical hub.

## Safety boundaries

- The Wiser hub remains schedule owner. Never install a parallel Home Assistant Scheduler schedule for heating.
- Real saves use Wiser WebSocket schedule endpoints, but **schedule reads and post-save readback can use integration-cached data**, not guaranteed fresh hub state. For this reason live saving is opt-in and unsuitable for unattended production edits.
- The card checks the cached schedule and cached assignment identities immediately before allowing a write, verifies the same again in the transport, and shows names of currently observed assigned rooms; this is best-effort detection, not an atomic compare-and-swap.
- A failed connection does not trigger repeated automatic requests from normal Home Assistant state updates. The user must choose Retry.
- The day editor displays setpoints continuing past midnight and shows the carried-over temperature before the day's first scheduled change.
- Input edits keep the DOM controls mounted until deliberate navigation/actions, avoiding the card-wide HTML replacement on each change.
- On valid time changes, adjacent "Until…" labels and the overnight carryover banner refresh **in place**, including when a midnight event adds/removes the carryover, without detaching the native time inputs. Chromium regression tests cover this.
- An edited schedule assigned to multiple rooms affects all those rooms. The UI prompts for confirmation before real shared-schedule edits.
- Passive-control/advanced schedules are view-only until the additional fields can be edited safely.
- Schedule edits are limited to eight daily periods; live discovery and hot-water handling are intentionally not part of this card.
- Existing Hive cards and demo helpers are retained while feature parity work continues.

## Next development milestones

1. Real-hub validation with a refresh-aware/transactional schedule-saving approach before recommending live edits. Automated Chromium tests cover the web UI; a full Home Assistant deployment remains to be tested.
2. Safe create/copy/assign schedule workflows; per-room unlink options for shared schedules.
3. Wiser climate controls, native boosts, cancellation, mode setting and advance schedule.
4. Replace original Hive setup wizard with Wiser room discovery; remove hot-water screens.
5. Combine Wiser cards and the original visual language into a single HACS-ready resource.
