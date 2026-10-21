# Optional capabilities

Pocket RPG Kit keeps feature-specific reducers and renderers behind explicit
registrations. This serves two separate purposes:

1. **Content admission** checks that a project cannot enter a command or state
   which its host cannot execute.
2. **Bundle isolation** keeps a concrete implementation out of the static
   import graph when the application does not import its separate package
   entry.

Those controls are related, but not interchangeable. Omitting a project field
can keep its state and per-frame work cold. It does **not** remove a renderer
which the application imports unconditionally. Conversely, importing a module
does not enable it until the application passes the matching `createSession`
option or `GameView` prop.

The static browser player applies the same rule at its host boundary. A
resolved `net.http` declaration adds PocketJS's bounded browser transport;
without it the namespace is absent and the ordinary player step has no HTTP
branch. Browser Gamepad support is an `input.buttons` source rather than a new
guest API: it is dormant until a standard controller connects, joins the
existing keyboard/touch mask while connected, and restores the original
no-controller path after disconnect. Configuration and the default physical
mapping are documented under [Browser HTTP and physical controllers](../README.md#browser-http-and-physical-controllers).

## Capability catalogue

### Strict content admission

These capabilities reject content at session creation or map acquisition when
the required reducer is absent. Checks recurse through common events and
nested branches, and sharded maps are checked before they are compiled or
cached.

| Capability | Project or content trigger | Host registration | If it is absent |
| --- | --- | --- | --- |
| RPG Maker text runtime | `system.rpgMakerText` | `rpgMakerTextRuntime` from `pocket-rpgkit/rpgmaker-text` | Session creation throws. The parser, text expansion and tone/weather reducer stay out of ordinary application graphs. |
| RPG Maker screen runtime | `screenTone` or `weather` commands | The same `rpgMakerText` runtime; its contract also owns the optional tone/weather reducer | Loading throws and names the commands which require it. |
| Screen presentation | `screenTone`, `weather`, numbered-picture, timer or map-name commands; or `system.mapNameDisplay: true` | `GameView screenPresentation`, normally `krm2ScreenPresentation` from `pocket-rpgkit/ui/krm2` | A rendering host throws instead of waiting on an invisible effect. A deliberate headless `createSession` caller may omit the presentation policy and inspect reducer state only. |
| Travel reducer | A project declares `followers` or non-empty `vehicles` | `travelRuntime` from `pocket-rpgkit/travel` | Session creation throws. |
| Battle rules | Any `battle` command | `createSession({ battle })`, or `GameView battle` | Session creation throws. In `GameView`, `battle` and `battleScene` must be registered together. |
| Scene rules | Any `scene` command id | Matching entries in `scenes` | Session creation throws for an unregistered id. `sceneViews` is a separate presentation map; omitting its entry is allowed but draws no full-screen scene. |
| Extension commands, choices and conditions | `ext`, `extChoice`, or an extension condition | Matching handlers in `extensions` | Unknown names are rejected. `allowUnknown` is an explicit preview/inspection escape hatch, not a production fallback. |

Travel presentation is deliberately separate from the travel reducer:

```tsx
import { travelRuntime } from "pocket-rpgkit/travel";
import { travelPresentation } from "pocket-rpgkit/ui/travel";

<GameView
  project={project}
  assets={assets}
  travel={travelRuntime}
  travelPresentation={travelPresentation}
/>
```

Registering only the reducer keeps follower/vehicle state functional, but no
travel actor nodes are mounted; a ridden player falls back to the ordinary
player rendering. Applications which need visible followers or vehicles
should register both halves.

An imported RPG Maker application commonly wires several capabilities at
once:

```tsx
import { rpgMakerTextRuntime } from "pocket-rpgkit/rpgmaker-text";
import { rpgMakerChoiceTextRuntime } from "pocket-rpgkit/ui/rpgmaker-text";
import { krm2ScreenPresentation } from "pocket-rpgkit/ui/krm2";
import { createRpgMakerBattleRules } from "pocket-rpgkit/rpgmaker-battle";
import { createRpgMakerBattleScene } from "pocket-rpgkit/ui/rpgmaker-battle";
import { createRpgMakerFormation } from "pocket-rpgkit/ui/rpgmaker-formation";

const battle = createRpgMakerBattleRules(database, {
  animations: project.animations,
  animationPositions: battleArt.animationPositions,
});
const BattleScene = createRpgMakerBattleScene(database, {
  enemyImages: battleArt.enemyImages,
  faces: battleArt.faces,
  battlebacks1: battleArt.battlebacks1,
  battlebacks2: battleArt.battlebacks2,
  animations: battleArt.animations,
});
const formation = createRpgMakerFormation({ faces: battleArt.faces });

<GameView
  project={project}
  assets={assets}
  rpgMakerText={rpgMakerTextRuntime}
  choiceText={rpgMakerChoiceTextRuntime}
  screenPresentation={krm2ScreenPresentation}
  battle={battle}
  battleScene={BattleScene}
  overlay={formation}
/>
```

The generated RPG Maker `coverage.md` lists the text and screen registrations
required by that import. Battle, scene, travel and other application-specific
registrations still follow the content and the integration code.

### Fail-soft host hooks

These hooks have a defined fallback instead of load-time rejection.

| Capability | Enable it | If it is absent |
| --- | --- | --- |
| Game text tokens | Declare `system.textTokens` and pass the pure `textTokens(key, view)` resolver | On the non-RPG-Maker text path, no declaration leaves `{x:key}` literal, while a declared key with no answer expands to `???`. The value is captured when the box opens so save, replay and rewind agree. `system.rpgMakerText` selects its separate backslash grammar instead. |
| Seam movement policy | Put `movementCapability` on a trusted world opening and pass `handoffCapability` | A capability-bearing opening stays blocked unless the policy returns `true`, even when its terrain is ordinarily passable. An admitted opening may relax only the destination solid bit; bounds, directional edges and character bodies still block. |
| Connected-world traversal | Declare `worldTraversal: "seamless-v1"` plus a matching `worldLayout`, and pass a world factory from `pocket-rpgkit/ui/world` | A missing or mismatched topology falls back to `legacy-transfer`. Live play and attract/refold receive the same registration. |
| Host audio | Import `createAudioEffects` from `pocket-rpgkit/ui/audio` and pass its component as `effects` | Audio state still advances deterministically, but no frame callback or sound output is installed. |
| Host actions | Pass the application's host-action handler | The reducer still reaches the action boundary, but no external side effect occurs. |
| Choice text styling | Pass `choiceText` from `pocket-rpgkit/ui/rpgmaker-text` | Escapes are still parsed by the registered text runtime; choice rows use the plain-text path. |

`system.stepCounter` is a project-only cold gate, while `immutableState` is a
session option. They do not add a package entry: they select sparse state or a
different reducer storage policy inside the core engine. Internal compile-time
flags such as the world-idle context bit work the same way and should not be
described as bundle isolation.

## Presentation and helper entries

The following package entries are opt-in at the **application import** layer.
Do not import them from a shared application barrel unless every resulting
bundle intends to pay for them.

| Package entry | What it contributes | Behavior when the application does not import/pass it | Isolation test |
| --- | --- | --- | --- |
| `pocket-rpgkit/rpgmaker-text` | RPG Maker escape parser plus screen tone/weather reducer | Projects which declare/use it fail admission; ordinary projects do no parsing or optional screen work | `tests/rpgmaker-capability-bundle-isolation.test.ts` |
| `pocket-rpgkit/rpgmaker-screen` | Direct tone/weather rule helpers for custom integrations | No direct helper API is imported. The module is still reached indirectly when an application imports `rpgmaker-text`, whose runtime owns these reducer rules | `tests/rpgmaker-capability-bundle-isolation.test.ts` (group boundary) |
| `pocket-rpgkit/travel` | Followers and vehicle reducer | Projects with travel data fail admission | `tests/rpgmaker-capability-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/krm2` | Tone/weather, numbered pictures, timer and map-name presentation | Required rendering content fails admission | `tests/krm2-ui-bundle-isolation.test.ts`, `tests/rpgmaker-capability-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/rpgmaker-text` | Coloured RPG Maker choice rows | Choices render as plain text | `tests/rpgmaker-capability-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/travel` | Follower and vehicle actors | Travel state works without visible travel actors | `tests/rpgmaker-capability-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/world` | Connected-world rendering, handoff and optional neighbour preview | The ordinary one-map renderer and legacy transfers remain active | `tests/world-ui-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/audio` | WAV/QOA host bridge and decoder | Silent deterministic audio state | `tests/audio-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/demo` | Chapter, warp and autoplay controls | Attract playback can still run without the menu | `tests/demo-ui-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/battle` | Generic state-driven battle widgets | No generic battle UI implementation in the bundle | `tests/battle-ui-bundle-isolation.test.ts` |
| `pocket-rpgkit/rpgmaker-battle` | RPG Maker front-view and side-view battle rules and importer extensions | Imported battle commands need another registered `BattleRules` or fail | `tests/rpgmaker-battle-isolation.test.ts` |
| `pocket-rpgkit/ui/rpgmaker-battle` | RPG Maker front-view and side-view battle scene | `GameView` requires it together with the RPG Maker battle rules | `tests/rpgmaker-battle-isolation.test.ts` |
| `pocket-rpgkit/ui/rpgmaker-formation` | Formation overlay | Formation access state persists, but no formation menu is drawn | **No bundle-isolation assertion.** Functional coverage: `tests/rpgmaker-formation.test.ts` |
| `pocket-rpgkit/ui/parallax` | Map parallax layer | Authored/runtime parallax state persists without a backdrop node | `tests/krm3v-ui-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/item-icons` | Item/shop icon rows | Text-only item and shop rows keep their dimensions | `tests/krm3v-ui-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/choice-icons` | Character icons beside choices | Rows fall back to text and warn once that the `choiceIconBox` presentation is missing | `tests/battle-ui-bundle-isolation.test.ts` |
| `pocket-rpgkit/ui/image` | Lazy indexed image cache/components | Existing eager `ui:img` sources continue to work | **No dedicated bundle-isolation assertion.** `tests/battle-ui-bundle-isolation.test.ts` only notes the entry in a comment |
| `pocket-rpgkit/ui/saves` | `GameView` session save/load helpers | The application owns any alternative save integration | **No dedicated bundle-isolation assertion.** Functional coverage: `tests/ks2-save-view-sim.test.ts` |

The world entry intentionally includes its sandbox preview implementation in
the entry's graph even when `npcPreview.sandbox` is off. The isolation boundary
is therefore **base UI versus `ui/world`**, not renderer versus sandbox within
that entry.

## Package-size checks

`tools/build-example.ts` writes `dist/<app>.inputs.json` beside each bundle.
Isolation tests inspect the pass-one source graph, concrete strings in the
final QuickJS bundle, or both, according to the boundary named in each test.
The RPG Maker capability test checks both artifacts, using Meadow and
Sunstone as negative controls and `rmi-play` as the positive control. It also
pins the current bundle sizes: **683,647 bytes for Meadow, 1,107,830 bytes for
Sunstone, and 1,297,182 bytes for `rmi-play`**. These are regression pins, not
the isolated cost of one feature; shared engine changes can move every pin.

Run the focused check after changing a capability boundary:

```sh
bun tools/build-example.ts meadow sunstone rmi-play
bun test tests/rpgmaker-capability-bundle-isolation.test.ts
```

The tests named in the catalogue use positive fixtures, ordinary-application
negative controls, or both. Rows which explicitly say that no isolation
assertion exists are known gaps. Where a pass-one manifest is available, keep
that source-graph assertion: a byte-size or final-string pin alone cannot prove
that an unwanted module stayed out.

## Adding an optional feature

Use this sequence for a feature which should cost nothing when unused:

1. Add an optional schema/type field only if project data selects the feature.
   Define the missing-field behavior and update the schema identity/changelog.
2. Put the base interface in a type-only contract. Put the concrete reducer,
   parser, adapter or renderer in a separate module and package export; do not
   runtime-re-export it from the base barrel.
3. Add nullable `SessionOptions` and/or `GameViewProps` registrations. Decide
   explicitly between strict admission and a documented fail-soft fallback.
4. Recursively scan common events, nested branches and inline maps. Repeat the
   check for lazy/staged shards **before** compilation and caching.
5. Forward the same registration through live sessions, attract mode,
   refold/rewind, save restore, headless tools and editor/preview hosts where
   those paths apply.
6. Short-circuit the absent path before allocations, comparisons or node
   creation. Assert no optional state, per-frame work or presentation nodes
   appear in the negative control.
7. Add a positive fixture and an ordinary application negative control to
   `tools/build-example.ts`. Check `*.inputs.json`, final-bundle module
   needles, and reviewed byte pins.
8. Test absence, partial registration, malformed/nested content, lazy shards,
   save/restore, rewind and supported simulation rates. A reducer/presentation
   pair needs a test for registering only one half.
9. Update package exports, this catalogue, the engine option reference,
   `docs/status.md`, and any importer required-capability report.

For per-frame optional work, also run the fixed-history QuickJS guard described
in [QuickJS performance checks](quickjs-performance.md). Bundle isolation and
runtime isolation protect different costs; a feature needs both when it adds a
hot-path check.
