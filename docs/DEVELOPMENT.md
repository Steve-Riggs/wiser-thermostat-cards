# Wiser Style Heating: first development slice

The original Hive-style assets and HACS manifest remain unchanged on `main`.
This branch adds an independent Wiser-native schedule editor. It does not install to Home Assistant or touch the existing Heating Demo dashboard.

## Build and test

Node.js 20+:

```sh
npm test
npm run build
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

**Do not enable live edit mode until you've backed up real schedules and reviewed the current integration schema.** The first development version is not production tested on a physical hub.

## Safety boundaries

- The Wiser hub remains schedule owner. Never install a parallel Home Assistant Scheduler schedule for heating.
- Real saves use Wiser WebSocket schedule endpoints; the card verifies against a fresh hub read before writing, then reads back.
- An edited schedule assigned to multiple rooms affects all those rooms. The UI prompts for confirmation before real shared-schedule edits.
- Passive-control/advanced schedules are view-only until the additional fields can be edited safely.
- Schedule edits are limited to eight daily periods; live discovery and hot-water handling are intentionally not part of this card.
- Existing Hive cards and demo helpers are retained while feature parity work continues.

## Next development milestones

1. Browser-level UI tests and physical Wiser integration compatibility validation.
2. Safe create/copy/assign schedule workflows; per-room unlink options for shared schedules.
3. Wiser climate controls, native boosts, cancellation, mode setting and advance schedule.
4. Replace original Hive setup wizard with Wiser room discovery; remove hot-water screens.
5. Combine Wiser cards and the original visual language into a single HACS-ready resource.
