# Static web HTTP and physical gamepad hosts

Change base: `be938da56905c96410ed9db4cf0345eca10cfc99`

Validated implementation: `0902d990fdda29323e2ab9b2b1c6f695908385b0`

Fixed cumulative-performance baseline: `a4dc4e72341ae6aa7373623f83dbd07124316a6d`

Pinned PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

PASS. The static player now mounts PocketJS's existing bounded `net.http`
host only when the resolved application manifest declares that capability. It
resets the host before use, admits completed transport facts once per frame at
the existing host boundary, and aborts and forgets requests when the player
fails. An undeclared application receives no `net` namespace and takes no HTTP
branch in its ordinary frame step.

Standard-mapped browser controllers now join keyboard and touch through the
same `BTN` mask. The default layout, deadzone, per-game override, connection,
disconnection, multiple-controller and missed-disconnect cases are covered.
Before a supported controller connects, and after the last one disappears, the
player's original `buttons()` path is left intact, so an idle controller source
adds no per-frame polling.

The clean component gate is 4,599 pass, 0 fail, 0 skip. Three isolated
mutations all turn the intended tests red. The QuickJS single-change and
cumulative guards both pass with no regression, inconclusive case or error.
The Wander and Tuxemon consumers build and pass their complete validation
matrices, including the real-Chrome web journeys. No PocketJS patch was needed.

## HTTP host boundary

`tools/web.ts` derives `netHttp: true` from the resolved build plan only when
`features["net.http"] === true`; the field is absent otherwise. The player
mounts `createNetHost` before evaluating the guest bundle. The mount resets the
host and wraps the existing audio `beginFrame` boundary, producing the order
audio -> HTTP -> socket/guest without adding an untaken HTTP conditional to
`Player.step()`.

The browser-global `net` namespace therefore exists only for a declared
application. A fatal boot or runtime failure resets the HTTP host, whose
PocketJS contract aborts active fetches and generation-rejects late
completions. Ordinary player teardown already reloads the document; there is no
second live player instance to retain a host.

The contract tests exercise the real PocketJS `createNetHost`, not a duplicate
transport implementation:

| Property | Covered behavior |
|---|---|
| Capability isolation | disabled mount neither calls the factory nor exposes `net` |
| Request size | 64 KiB accepted; 64 KiB + 1 rejected synchronously |
| Response size | an over-budget body produces `response_too_large` |
| Timeout | the fetch signal is aborted and the timeout event appears at the next frame |
| Redirects | manual, same-scheme redirect handling is capped at three hops |
| Credentials/cache | every fetch uses `credentials: "omit"` and `cache: "no-store"` |
| Frame batching | settled requests remain invisible until `beginFrame`, then appear in one batch |
| Reset | active work is aborted and neither a late event nor body can be observed |

Browser CORS and mixed-content policy remain authoritative. The implementation
uses PocketJS's existing request concurrency, body, response, redirect and
deadline bounds; no fork or submodule edit was required.

## Physical gamepads

`tools/web/gamepad.ts` is a browser-host adapter. It accepts only Gamepad API
entries whose `mapping` is `"standard"`, remembers connected indices, samples
live state from `navigator.getGamepads()`, and ORs all accepted controllers with
the keyboard/touch result. Axes 0/1 and the physical d-pad both produce the
directional `BTN` bits; input is deliberately not routed around the player or
through an undeclared analog guest API.

The default deadzone is `0.25`, applied strictly. The default physical map is:

| Standard button | PocketJS button |
|---:|---|
| 0 (south / A) | `CIRCLE` (confirm) |
| 1 (east / B) | `CROSS` (cancel) |
| 2 (west / X) | `TRIANGLE` |
| 3 (north / Y) | `SQUARE` |
| 4 or 6 | `LTRIGGER` |
| 5 or 7 | `RTRIGGER` |
| 8 | `SELECT` |
| 9 | `START` |
| 12 / 13 / 14 / 15 | `UP` / `DOWN` / `LEFT` / `RIGHT` |

A game's `web.json` may override the deadzone and physical indices 0 through
31. Overrides merge onto the defaults and `null` explicitly unbinds an index.
The site builder validates the object, finite 0..1 deadzone, canonical integer
keys and known button names once, then serializes the compiled masks.

The adapter installs a one-time pair of browser connection listeners. It does
not create an own `buttons` method until an accepted controller exists. A
disconnect removes the index and immediately restores the original method when
the live set becomes empty; polling also prunes a missing or no-longer-standard
slot in case the browser loses the disconnect event. This prevents held input
from surviving a disconnect and restores the exact keyboard/touch-only hot
path.

The real-browser smoke starts headless Chrome, replaces
`Navigator.prototype.getGamepads` before the player module loads, and dispatches
native browser `gamepadconnected` / `gamepaddisconnected` events. It proves that
the Chrome realm can load the module, poll live synthetic state, aggregate BTN
bits, and clear the patch on disconnect. Its explicit limitation is that it
does not test USB/HID discovery or a vendor driver's nonstandard mapping; those
require physical hardware, and nonstandard mappings are intentionally ignored.

## Discriminating mutations

Each mutation ran in a separate disposable copy; the candidate worktree was
never modified by a mutation.

| Isolated mutation | Red result |
|---|---|
| Make HTTP reset leave active work alive | reset test expected `signal.aborted === true`, received `false` |
| Keep the gamepad patch after the final disconnect | lifecycle test expected no own `buttons` override, but one remained |
| Mount HTTP for an undeclared application | isolation test reached its forbidden host factory and failed |

These failures distinguish cleanup, stale-input prevention and capability
gating rather than merely executing the new code.

## Bundle and dormant-path isolation

The four representative guest application bundles are byte-identical between
base and candidate:

| Bundle | Base bytes | Candidate bytes | Delta |
|---|---:|---:|---:|
| Meadow | 684,379 | 684,379 | 0 |
| Sunstone | 1,108,562 | 1,108,562 | 0 |
| Grow | 864,340 | 864,340 | 0 |
| rmi-play | 1,297,914 | 1,297,914 | 0 |

Wander gives the same consumer-level result. Its guest JavaScript and pak are
byte-identical; only the shared static-player shell changes:

| Wander web artifact | Base | Candidate | Delta / identity |
|---|---:|---:|---|
| `wander.js` | 907,002 B | 907,002 B | identical SHA-256 `c00e80bd30bf070d4b2384f29d7f495d8d36db1e879f85ca79c0f1479a919cef` |
| `wander.pak` | 1,356,112 B | 1,356,112 B | identical SHA-256 `3c48570525b525272bf3c85786c9284defad5f49073fdaa82f7b31c17c5bff76` |
| shared `player.js` | 69,986 B | 76,688 B | +6,702 B |
| complete `dist/web` | 8,906,769 B | 8,913,471 B | +6,702 B |

Thus optional hosts do not enter or perturb a guest application bundle. The
site-wide player asset necessarily contains the browser adapters once and grows
6,702 bytes; it would be inaccurate to call the complete web directory
byte-identical. Runtime isolation is structural: undeclared HTTP omits host
construction and frame pumping, while no-controller input leaves the original
`buttons()` method installed.

## QuickJS performance guard

The isolated guard ran pinned to CPU 6 with:

`PR1_QJS_CPU=6 tools/pr1-quickjs-bench.sh --guard be938da5`

The script interleaved base and candidate windows and separately compared the
candidate to the fixed cumulative baseline. Values are median deltas with the
95% window-bootstrap interval:

| Workload | Single change | Cumulative |
|---|---:|---:|
| `sunstoneIdle` | +1.03% [-0.65, +2.13] | -0.94% [-2.23, -0.14] |
| `sunstoneWalk` | +0.29% [-0.59, +1.73] | -4.09% [-5.98, -0.55] |
| `sunstoneControlWalk` | -0.08% [-0.24, +0.19] | -2.08% [-4.64, +5.77] |
| `streamedRoam` | +0.04% [-4.10, +1.73] | -0.60% [-2.75, +10.38] |
| `battleScene` | +0.27% [+0.10, +2.35] | -0.57% [-2.31, +5.82] |
| `sunstoneIdleImmutable` | -0.40% [-5.03, +0.24] | +0.09% [-1.53, +1.43] |
| `sunstoneControlWalkImmutable` | -1.12% [-1.56, -0.89] | -2.45% [-7.85, -1.28] |
| `battleSceneImmutable` | -2.45% [-9.50, +6.08] | -3.94% [-4.19, -1.91] |

The machine-checked final result was
`verdict=pass regressions=0 inconclusive=0 errors=0` for both the single and
cumulative comparisons.

## Component gates

The final gate started from a removed `dist/` directory.

| Command or check | Result |
|---|---|
| focused HTTP, Gamepad, site and player tests | 86 pass, 0 fail |
| `bun run build:wasm` | exit 0 |
| `bun run build:example` | exit 0 |
| `bunx tsc --noEmit` | exit 0, no diagnostics |
| QuickJS guard analyzer tests | 11 pass, 0 fail |
| complete `bun test` | 4,599 pass, 0 fail, 0 skip; 730,684 assertions across 300 files in 542.76 s |

`bun.lock` is unchanged. The PocketJS submodule remains at the pinned revision,
so there is no hidden dependency or unsubmitted engine patch.

## Consumer validation

### Wander

A disposable Wander worktree used the validated component commit. Its desktop
build, web build and `bunx tsc --noEmit` all passed. The complete test suite
reported 523 pass, 0 fail, 0 skip across 45 files. The byte comparison above
was made from independent base and candidate web builds.

### Tuxemon

A disposable Tuxemon worktree used the same component commit and a real
Tuxemon source checkout. Import, Wasm build and web build passed. Because its CI
intentionally partitions the suite to bound memory, the exact five CI groups
were run sequentially and together cover every test file:

| CI group | Result |
|---|---|
| importer | 55 pass, 0 fail |
| deterministic replays | 12 pass, 0 fail |
| locks / battle / terrain | 361 pass, 0 fail |
| rest A-L | 746 pass, 2 browser-condition skips, 0 fail |
| rest M-Z | 685 pass, 4 browser-condition skips, 0 fail |
| **default total** | **1,859 pass, 6 conditional skips, 0 fail** |

The two conditionally skipped browser files were then rerun under the browser
condition and reported 9 pass, 0 fail. This covers all default and browser-only
tests; the component library's own acceptance gate itself had zero skips.

The web build passed, including its ordinary-replay isolation check. Every
real-Chrome verifier passed: journey, Chinese UI, demo/autoplay, battle arena,
expedition, double-input regression, audio and language switching. The generic
static-web verifier also passed sizing, subpath, network and console checks; it
reported one expected non-failure skip because this consumer intentionally does
not list the optional preview application.

The browser checks preserve the keyboard and touch path while the new adapter
is present. In particular, the double-input verifier passed, the journey
finished at its pinned location with zero canvas byte mismatches, and all
verifiers reported no unexpected console or network errors.

## Visual inspection

Three generated Chrome frames were opened at full detail rather than accepted
by hashes alone:

- `density-dialog.png` shows a coherent Paper Town map, player and dialog at
  native density, with no clipping or duplicated input state.
- `02327-battle-menu.3x.png` shows readable Chinese battle commands, intact
  monster composition and correctly placed HUD panels.
- `phone.page.png` shows the portrait touch pad, demo disclosure, links and
  control table without overlap or horizontal breakage.

No visible rendering corruption, held controller state or broken mobile layout
was found.

## Public documentation

The README documents capability gating, HTTP bounds, browser policy, the full
default physical map, deadzone and `web.json` override syntax, disconnect
behavior, and the Chrome-smoke limitation. `docs/capabilities.md` records the
dormant-path rule. `docs/status.md` marks static-player HTTP and browser
physical controllers Done with direct test and usage pointers.

subagent 使用：3 / HTTP contract、Gamepad 设计、验证矩阵 / 是，调研并行节省时间

PASS
