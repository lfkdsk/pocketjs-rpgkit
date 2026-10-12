# Immediate scripted motion and modal backdrop stacks

Base: `49b19d5a6e8948e951c52fd231e7aa7072707724`  
Pinned PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`  
Schema identity: `a59ec3e0a1ee74fe08fb75dff938e56b01b8b6b66ccfd102cb9dbb2866d23444`

## Verdict

The component library now has two additive authoring paths for Tuxemon-style
timing and presentation. `{op:"face"}` changes the player, the issuing event,
or another event at the instruction boundary, and
`moveRoute.start:"immediate"` consumes exactly the first route command in the
publishing reference tick. Rendering, later facing conditions, interaction
targeting, touch edges, followers and ridden vehicles all observe that state.
Omitting the new field retains the established next-tick route start.

`screenBackdrop` now owns a sparse, saved, LIFO stack. Its visible top can be
replaced, a modal-covered action can push a new top while dismissing and
advancing the modal owner, and a null variant pops the top to expose its
nearest predecessor. The stack survives save/load, rewind and transfer. It is
bounded at eight total frames; a ninth push becomes a deterministic content
error before either the modal or stack changes.

Both changes are schema-additive. A real shell/save pair from the immediately
preceding schema generation opens and continues, and projects which omit the
new command and fields retain their old behavior. The main-vs-candidate gate
compared 35 opt-out scenarios and 11,414 reducer states byte-for-byte.

| Acceptance area | Result | Evidence |
| --- | --- | --- |
| Same-tick facing, condition and interaction visibility | PASS | focused reducer, touch-trigger and render tests |
| Optional same-tick first route command | PASS | player/event/follower/vehicle tests at 60/30/20 Hz |
| Legacy route timing | PASS | omission remains parked at route pc 0 until the next tick |
| Modal-aware backdrop push/replace/pop/expose | PASS | dialog-owner, LIFO, transfer and overflow tests |
| Save/load and rewind | PASS | motion and complete stack round trips plus deterministic refolds |
| Additive schema compatibility | PASS | generated predecessor project/save fixture and identity gate |
| Visible demonstration | PASS | six manually inspected 3x goldens with semantic pixels |
| Mutation strength | PASS | all four required isolated regressions turn focused tests red |
| Opt-out behavior and consumers | PASS | 35-scenario equivalence, Tuxemon tapes and Wander suite |
| QuickJS dormant cost | PASS | every accepted median is below the +3% limit |
| Cold gates | PASS | clean Wasm/example builds, TypeScript, and 4,543 complete-suite tests |

## Pinned Tuxemon semantics

The source comparison uses Tuxemon `9e6258ff`.

- `char_face.start` resolves the character and direction, then calls
  `set_facing` in the action invocation itself
  (`tuxemon/event/actions/char_face.py:38-65`).
- `char_move.start` parses the authored path and immediately calls
  `set_path_and_start`; its update waits until both movement and the path have
  finished (`tuxemon/event/actions/char_move.py:50-88`).
- `change_bg` first pops an extra covering state, then closes or opens an image
  state as appropriate (`tuxemon/event/actions/change_bg.py:54-95`).
  `change_bg_char` and `change_bg_monster` likewise pop a covering state and
  always push their portrait state
  (`change_bg_char.py:57-80`, `change_bg_monster.py:50-83`).
- Tuxemon's state stack pushes at the top, removes the current top, and resumes
  the newly exposed state (`tuxemon/state/stack.py:16-80`,
  `tuxemon/state/manager.py:163-177,267-304`). That is the ordering this
  backdrop stack preserves.

## Immediate facing and route startup

The public command surface is deliberately additive:

```ts
{ op: "face", target: "player" | "this" | { event: string }, dir: Dir }
{
  op: "moveRoute",
  target: "player" | "this" | { event: string },
  start?: "immediate",
  wait?: boolean,
  route: MoveRoute,
}
```

`face` publishes an ordered move request but also records a sparse fold-local
player direction. Consequently an `if facing` later in the same event fold
sees the new direction before the session drains the request. The drain then
updates the render-facing and step-facing state in that same reference tick.
Event targets are turned in place through the character reducer.

An immediate route is installed after the ordinary movement phase, exactly as
before, then consumes one freshly installed route command. A movement command
therefore begins interpolation in the publishing tick; a turn, wait, control
or path command consumes only its own first-command semantics. Remaining route
commands continue on normal reference ticks. A route without `start` never
enters this cold path and retains the previous timeline byte-for-byte.

An immediate turn or attempted step can create a new touch edge after the
ordinary trigger scan. The follow-up scan is intentionally restricted to
`playerTouch` and `eventTouch`: it clears confirm/directional edges, cannot
restart autorun or parallel pages, and starts a newly captured blocking fiber
on the following reference tick. Follower breadcrumbs and ridden-vehicle
position are reconciled after the immediate step.

The focused suite covers schema rejection, same-fold facing, legacy delay,
player and event routes, facing-gated player touch, blocked event touch,
60/30/20 Hz agreement, followers, vehicles, save/load and rewind.

## Backdrop stack and modal contract

`ScreenEffectsState.backdrop` remains the visible frame. The optional
`backdropStack` stores hidden frames from oldest to nearest predecessor, so a
pop removes its last entry. Empty stacks are pruned; projects which never push
pay for neither the array nor per-frame stack work.

The authoring rules are:

| Command shape | Effect |
| --- | --- |
| non-null variant, no policy | replace only the visible top, including below a modal |
| `whenModalOpen:"ignore"` | preserve an existing top while a modal covers it; otherwise replace |
| `whenModalOpen:"push"` with a modal | preflight depth, dismiss and advance the modal owner, preserve the old top, show the new top |
| `whenModalOpen:"push"` without a modal | replace the visible top |
| omitted/null variant | pop the visible top, exposing the nearest predecessor or closing the backdrop |

The total visible-plus-hidden depth limit is eight. At depth eight a covered
push reports `screenBackdrop in <fiber>: stack depth exceeds 8`; preflighting
before modal dismissal makes overflow atomic. Save validation rejects a stack
without a visible top, an empty stored array, malformed entries, or total
depth above the limit.

The hand-written screen clone copies every stack entry. That clone is used by
interpreter snapshots, save envelopes, rewind keyframes and transfer cleanup;
transfer removes map-local transients but deliberately retains the visible
backdrop and all hidden predecessors.

## Schema, editor and compatibility

The schema adds the `face` command, the optional
`moveRoute.start:"immediate"` field, and the optional
`screenBackdrop.whenModalOpen:"push"` enum value. Runtime types, bytecode,
save validation, JSON schema, embedded editor schema, command explanation,
read-only field preservation and world-preview classification were updated
together.

The canonical schema hash is
`a59ec3e0a1ee74fe08fb75dff938e56b01b8b6b66ccfd102cb9dbb2866d23444`.
The outgoing identity
`f3a5eb5da11bb5eed3fcad2f7e04409883b06f68addeeb48f64d2b3e6afd7db1`
is first in the compatible list. Its committed project shell and save were
generated with the predecessor runtime rather than hand-authored; the current
runtime validates, restores and advances both.

`tools/pr1-equivalence.sh` compared base `49b19d5a` with candidate
`71190492`: all 35 scenarios and 11,414 produced/retained states matched.
This includes Sunstone at 60/30/20/4 Hz, attract mode, Grow, Meadow, streamed
maps, inline/sharded repositories, battles, shop save/restore and modal
freeze. The opt-out path is therefore behaviorally unchanged.

## Visible fixture and manual inspection

The `ka1-anim` fixture exposes a dedicated stage that performs a same-tick
right turn/route start, opens a blue backdrop, pushes a red portrait frame
through a covering dialog, then pops back to blue. The renderer test runs at
480x272 and 960x544.

Semantic assertions require the moving actor's blue right-facing body, all
four red corners on the pushed full-screen frame, and a blue corner after the
predecessor is exposed. The six PNGs were opened at 3x: the actor visibly
faces and moves right, the pushed frame is solid dark red, and the exposed
frame is solid dark blue at both resolutions.

| Golden | SHA-256 |
| --- | --- |
| `ktux1-immediate-480x272.png` | `73543a52df6e3302c78685669c147ac41e402352704c935b1e41c3b0afe5194c` |
| `ktux1-immediate-960x544.png` | `ef9fdee7decfc68e43c87f4f6501fa4a10796d7c7bdc265b53a501c316feabbb` |
| `ktux1-stack-pushed-480x272.png` | `b51434d98506f72529d3ad4f6a2ba0740e6078efd392f6d047abbc0ca3b2e702` |
| `ktux1-stack-pushed-960x544.png` | `25abdca90d5d5c8eed6491046d0b912f1417101cd910da1c6970e5d26484e982` |
| `ktux1-stack-exposed-480x272.png` | `729c5c3223c2e9ad2e3a65f55675a9c34e02608b4da1af21db60bd7f80f784b8` |
| `ktux1-stack-exposed-960x544.png` | `b9809c7169f346a2b28e4b823597c22a407273eecee27f738299143296d92abe` |

## Mutation testing

Each mutation ran alone in a detached disposable worktree; every worktree and
its initialized submodule were removed afterward.

| Deliberate regression | Focused red evidence |
| --- | --- |
| Do not apply a published player `face` in the session tick | expected facing/stepDir 3, received 0; the new player-touch fiber was also absent |
| Make facing conditions read only the tick-start input | expected `saw-right === true`, received `undefined` |
| Expose the oldest hidden backdrop with `shift()` | expected `frame-6`, received `frame-0` |
| Omit `backdropStack` from the hand-written screen clone | save/restore expected the hidden `first` frame, received `undefined` |

The implementation worktree was never modified by a mutation.

## Consumer behavior and size

The consumer checkouts changed only their component revision from base to the
candidate. Tuxemon's tape-focused suite passed 38/38. Its 20 chapters cover
206,822 combined frames; snapshots and thumbnails remained byte-identical and
the terminal pin remained `4c7b0a028336`. Wander's built-consumer suite passed
508/508 with no skips.

| Output | Base | Candidate | Delta | Attribution |
| --- | ---: | ---: | ---: | --- |
| Tuxemon JavaScript | 2,231,388 B | 2,240,329 B | +8,941 B | shared command/interpreter/save support |
| Tuxemon PAK | 80,655,760 B | 80,655,760 B | 0 | assets unchanged |
| Wander JavaScript | 945,496 B | 955,634 B | +10,138 B | shared command/interpreter/save support |
| Wander PAK | 1,132,768 B | 1,132,768 B | 0 | assets unchanged |
| Meadow JavaScript | 722,929 B | 733,064 B | +10,135 B | same shared runtime path |
| Sunstone JavaScript | 1,161,185 B | 1,172,907 B | +11,722 B | shared runtime plus its existing audio/demo graph |
| WAV fixture JavaScript | 925,393 B | 935,528 B | +10,135 B | same shared runtime path; decoder boundary unchanged |

The candidate Tuxemon PAK hash is
`ef2c405448ca7a5868312ec403c7cde1461d4d7aad56a5c636a032b6893f0d5e`;
the Wander PAK hash is
`583955c2b34b16b1c7f85f81faac2a6d89ba8a99aebd3d14c95e09b73ca472e8`.
The bundle-isolation needles still prove that unrelated audio, battle,
name-input, editor and proposal-review modules do not enter ordinary games.

## QuickJS performance

The full interleaved run used five
main -> candidate -> candidate -> main windows, 2,000 iterations per slot,
on logical CPU 10. Candidate `1110fde0` differs from the final implementation
tip only by bundle pins and tests.

| Workload | Median candidate delta |
| --- | ---: |
| `battleScene` | -2.93% |
| `battleSceneImmutable` | +1.32% |
| `streamedRoam` | -4.03% |
| `sunstoneControlWalk` | -0.03% |
| `sunstoneControlWalkImmutable` | +0.53% |
| `sunstoneIdleImmutable` | -2.09% |
| `sunstoneWalk` | +1.66% |
| `sunstoneIdle` | +3.25% in the noisy full table |

The full-table idle result was dominated by its extreme first window. A
focused nine-window run with 3,000 iterations per slot (18
direction-balanced pairs) measured `sunstoneIdle` at -0.05% median and +0.34%
mean. That accepted rerun is below the +3% limit. The sparse request gate,
cold touch-scan helper and absent-by-default fold-local facing cell keep
projects which do not author the new fields off the additive work path.

## Tuxemon importer handoff

The game-side task should re-run the importer globally; generated output must
not be hand-edited.

1. Lower a cardinal `char_face` to `{op:"face", target, dir}`. Keep existing
   transfer/placement/spawn folds, since they already express the same state
   without an extra command. A target-relative direction (`player` or another
   character name) should retain its `turnTowardPlayer`/`turnToward` route but
   add `start:"immediate"`. Invalid directions and missing source NPCs retain
   their current dropped/content-error classification.
2. Add `start:"immediate"` to native `char_move` routes for the player,
   issuing event and arbitrary NPCs. Preserve `wait`, `skippable`, authored
   repetition and the four Surf actions already absorbed into shoreline
   geometry. This upgrades the current 124 player/self faces and nine ordinary
   player/self moves from delayed degradation; coverage rows and importer
   docs must change with the generated project.
3. Keep a close as `{op:"screenBackdrop", variant:null}`. Use
   `whenModalOpen:"push"` for `change_bg_char` and `change_bg_monster`, and for
   an ordinary background open whose source state transition should dismiss a
   covering modal and preserve the earlier frame. With no modal this policy
   deliberately replaces, matching the ordinary pop-then-open sequence.
   If control-flow analysis cannot determine normal `change_bg` behavior under
   a concurrently owned modal, keep that row Degraded rather than silently
   claiming exactness. Never truncate a statically provable ninth pushed frame;
   report it as unsupported or let the deterministic content error expose it.
4. Update `tests/importer.test.ts`, `tests/g-persist-import.test.ts`,
   `docs/importer.md` and `docs/status.md` from the old next-tick/`ignore`
   expectations. Re-import twice and require a byte-identical generated tree.

The opt-in changes event timing, so recordings must be validated from their
earliest divergence rather than repinned blindly. The opening G6/GB6 flows
contain portrait backgrounds and scripted facing; if they diverge, re-record
the G6/GB6 mainline and both loss tapes first, then J1 through J4 in dependency
order. Rebuild `data/chapters.json`, chapter thumbnails and Chinese
transcriptions from the new English chain. At minimum re-run
`verify:gb6:mainline`, `verify:gb6:failures`, every J1-J4 mainline verifier,
`verify:goldens:sync`, `verify:chapters`, `verify:zh:tape`, `verify:zh:demo`
and `verify:save`. A segment which remains byte-identical needs no re-record.

## Cold gates and repository state

The cold sequence began after deleting `dist/`:

| Command | Result |
| --- | --- |
| `bun run build:wasm` | exit 0; web Wasm 359,675 bytes |
| `bun run build:example` | exit 0 |
| `bunx tsc --noEmit` | exit 0, no diagnostics |
| `bun run test` | 4,543 pass, 0 fail, 0 skip; 730,312 assertions in 295 files, 497.63 s |

The final fetch left `origin/main` at `49b19d5a`, which is an ancestor of the
branch; the required rebase is current. There are no merge commits,
`bun.lock` is unchanged, and the PocketJS submodule remains at `862040bd`.

subagent 使用：3 / facing semantics、backdrop/upstream semantics、validation/performance matrix / saved parallel review time

PASS
