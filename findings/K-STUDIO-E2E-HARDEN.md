# Studio desktop E2E hardening

Baseline: `318df0d0`.

## Result

The intermittent dirty-close failure was a stale canvas-coordinate race, not delayed edit state. Closing the play-test panel changes the canvas width and schedules `canvas.fit()` two animation frames later (`editor/studio/main.ts:390-398`). The old test calculated a cell's client point while that refit was still pending and dispatched the mouse at that point after the camera had changed. The pointer still reached the canvas, but no longer addressed the planned cell, so no edit was committed and `session.isDirty()` correctly remained false.

The E2E now waits on observable conditions instead of sleeping:

- `clickCell()` first drains the known two-frame deferred refit, then requires two consecutive settled observations with unchanged canvas geometry and camera values. It also verifies that the computed point hit-tests to the map canvas before calculating the final click coordinate (`studio-desktop/e2e/studio-desktop.test.mjs:91-120`).
- `paintCell()` pins the session identity and requires the intended tile, a revision increment, exactly one new history entry, and dirty state (`studio-desktop/e2e/studio-desktop.test.mjs:122-149`).
- `selectCell()` verifies select mode, rejects an already-selected target, pins the session, and requires the exact selected cell (`studio-desktop/e2e/studio-desktop.test.mjs:151-170`).
- Project-opening steps require a new session plus the exact map and save target, closing a separate state-leak race where broad kind-only predicates could already be true for the preceding project (`studio-desktop/e2e/studio-desktop.test.mjs:191-203`).
- The dirty-close test explicitly restores the `ground` layer and `pencil` tool instead of depending on the preceding PNG test (`studio-desktop/e2e/studio-desktop.test.mjs:679-687`).
- The browser PNG-import E2E uses the same deferred-refit/stable-geometry barrier and waits for both the selected brush and painted tile (`studio-desktop/e2e/studio-png-import-browser.test.ts:49-76`, `:120-128`).

No fixed delay was added to establish that painting succeeded, and no assertion was weakened. The existing 700 ms wait remains only for the desktop host's separately polled close guard after the direct dirty assertion has already passed.

## Root-cause evidence

Painting itself is synchronous. Canvas `pointerup` immediately calls `commitStroke()` (`editor/studio/canvas.ts:1073-1085`), which calls `app.run("paint-cells", ...)` (`editor/studio/canvas.ts:1118-1135`). A successful session commit immediately replaces state and appends history (`editor/api/session.ts:449-456`), while `isDirty()` directly compares that state with its saved baseline (`editor/api/session.ts:255-275`). The desktop host's 300 ms dirty-report bridge is separate from the failed assertion, which directly read `session.isDirty()`.

Temporary diagnostic instrumentation inserted a controlled 50 ms pause after calculating the point and before dispatching the click. It produced this transition in the original failing test:

| Observation | Point calculation | Mouse dispatch / after |
| --- | ---: | ---: |
| dispatched client point | `(354, 282.5)` | `(354, 282.5)` |
| correct point for planned cell | `(354, 282.5)` | `(440.2643684677871, 314.737058408734)` |
| zoom | `0.75` | `1.4987976338118556` |
| pan | `(-48, -259.3333333333333)` | `(-45.60384757180206, -123.30176319084623)` |
| planned tile | `town.43` | `town.43` |
| revision / history | `0 / 0` | `0 / 0` |
| dirty | `false` | `false` |

The pointer events still targeted `map-canvas`, but the same dirty assertion failed. Without the pause, the tile changed to `town.0`, revision/history became `1/1`, and dirty became true. This distinguishes a stale-coordinate race from asynchronous edit completion or a missed DOM target. The delay and diagnostic logging were removed from the final code.

## Repetition and discrimination

Linux desktop runs used the workflow path with no inherited `DISPLAY`, one Xvfb/Electron instance at a time, and the spec reporter:

```sh
XVFB=<xvfb> STUDIO_E2E_REPORTER=spec bun run e2e
```

| Build | Runs | Failures | Observed failure rate |
| --- | ---: | ---: | ---: |
| unmodified `318df0d0` baseline | 20 | 0 | 0% |
| hardened test | 20 | 0 | 0% |

The supplied CI observation remains consistent with a low-frequency race: its first Linux attempt failed and the same commit passed on retry. Because the unmodified race did not occur naturally in this 20-run local sample, a controlled point-to-click delay supplied the discriminating reproduction: the original helper failed `1/1`; the final helper passed `5/5` under the same 50 ms stress.

An initial attempted baseline batch was excluded because every invocation stopped before Electron with the explicit harness error `no DISPLAY and no Xvfb`; it was an environment failure, not a test result. The valid counts above include only completed test runs.

## Similar assertion and state-isolation audit

All map-cell call sites in the desktop file now use semantic helpers:

- paint-and-save and disk-conflict flows use `paintCell()`;
- agent selection and both play-test launch flows use `selectCell()`;
- imported tile painting waits for brush selection and uses `paintCell()`;
- dirty-close explicitly closes the panel, restores layer/tool state, and uses `paintCell()`.

The browser PNG-import test received equivalent brush, canvas, and tile postconditions. Fixed waits used for animation progress, screenshot settling, or Electron's close-guard bridge remain; none establishes whether a click painted or selected the intended cell.

## Gates

Before the final gates, `dist/` was deleted. Heavy commands and desktop/browser E2E runs were kept serial so that only one Electron/Xvfb instance was active.

| Gate | Result |
| --- | --- |
| `bun run build:wasm` | PASS; generated wasm was 455,380 bytes |
| `bun run build:example` | PASS |
| `bunx tsc --noEmit` | PASS |
| `bun run test` | PASS; 4,790 tests across 311 files, 734,587 expectations, 0 failures, 0 skips |
| `CHROME=/usr/bin/google-chrome bun run e2e:png-browser` | PASS; 1 test, 16 expectations, 0 failures |
| Linux desktop E2E | PASS; ordinary smoke plus 20/20 post-fix runs |
| controlled 50 ms desktop stress | PASS; 5/5 with the final helper |

The prior continuation run ended after about one hour because machine memory pressure caused `systemd-oomd` to kill the Fleet service unit. That interruption was unrelated to the code or test results. This continuation kept all repeat runs serial and did not overlap the full suite with E2E.

## Visual review

- `docs/screenshots/studio-desktop/playtest.png`: the map canvas and play-test dock were both visible, the selected start cell `(9,7)` was correct, and neither panel was clipped.
- `dist/png-import-playwright/png-import-grid.png`: the import dialog showed two 16 px source cells with the offset/spacing guides intact.

The desktop screenshot files were restored after inspection because repeated captures contain nondeterministic pixels unrelated to this test-only change.

subagent 使用：3 / 分别审查根因事件链、跨测试状态隔离、测试辨识力与同类立即断言 / 是，并行只读审查节省了串行核对时间。

PASS
