# Schema compatibility fixtures

One directory per earlier schema identity, named `gen-<first 8 hex digits>`.
Each holds the sharded `project.json` and a mid-game `save.json` written by
the RPG Kit revision of that generation; `maps/` holds the map entries, which
are byte-identical in every generation. `tests/schema-compat.test.ts` opens
each shell and restores each save with the current runtime.

Regenerate one generation from the revision that produced it:

```sh
rev=<commit>            # last commit before the schema changed again
dir=$(mktemp -d)
git archive "$rev" src tools/lib | tar -x -C "$dir"
bun tests/fixtures/schema-compat/generate.ts "$dir" "$dir/out"
cp "$dir/out/project.json" "$dir/out/save.json" tests/fixtures/schema-compat/gen-<hash8>/
```

When a schema change is additive, add a fixture for the outgoing identity
(generate it from the commit before the change) together with its entry in
`MAP_SCHEMA_COMPATIBLE_HASHES` and the CHANGELOG table. When it is breaking,
the outgoing identity's fixture stays as a refused one, and it gets a
`witness.json`: a case in `witness.ts` that is valid under both schemas but
plays differently, recorded by the commit before the change.

```sh
bun tests/fixtures/schema-compat/witness.ts "$dir" <case>   # $dir as above
```

`inflight-common-constructed/` is not a generation fixture: it is a
**constructed compatibility probe** for the restore-time label-scope
reconstruction. A labels-capable runtime (0f14c2e) writes a save whose main
fiber is parked inside a called common event (a waited fade), and the `unit`
label-scope markers are then stripped from the saved frames by hand, so the
save has the *shape* of a pre-`unit` save but was not naturally produced by
one (0f14c2e already serializes `unit` as an ordinary enumerable field). The
page root and the common event both declare a label named "same", and the
common event jumps to it after the fade; the restored continuation must land
the jump in the common event's own scope (commonLanded) and not the page
root's (pageLanded). It exercises the restore-time label-scope
reconstruction. Regenerate it from the labels-capable revision:

```sh
dir=$(mktemp -d)
git archive 0f14c2e src tools/lib | tar -x -C "$dir"
bun tests/fixtures/schema-compat/generate-inflight.ts "$dir" "$dir/out"
cp -R "$dir/out/." tests/fixtures/schema-compat/inflight-common-constructed/
```

`inflight-common-oldgen/` is a **genuine old-generation in-flight save**: it
was written by the pre-KRM3 runtime `db2de159` (the generation that produced
`gen-0e510772`), which has no `label`/`jumpLabel` commands at all. Its main
fiber is parked inside a called common event (a waited fade), so it exercises
the same restore path (a two-frame stack rebuilt on load) with a save a real
old runtime produced naturally — no hand editing. The page calls the common
event and then sets a switch; the common event fades and sets a switch.
`expected.json` records the old runtime's continuation past the wait (both
switches set, fiber ended); the current runtime's restored continuation must
match, proving the restore migrations leave a genuine old save's behavior
unchanged. Regenerate it from the pre-KRM3 revision:

```sh
dir=$(mktemp -d)
git archive db2de159 src tools/lib | tar -x -C "$dir"
bun tests/fixtures/schema-compat/generate-inflight-oldgen.ts "$dir" "$dir/out"
cp -R "$dir/out/." tests/fixtures/schema-compat/inflight-common-oldgen/
```

`expected.json` records the old runtime's continuation past the wait (the
switches it sets and that the fiber ends); the current runtime's restored
continuation must match.

| Directory | Written by | Loads | Counterexample |
| --- | --- | --- | --- |
| `gen-e763f489` | `6709c69a` | yes | |
| `gen-11227c99` | `4d000ad` | yes | |
| `gen-1127febb` | `f49c0e2b` | yes | |
| `gen-5f14109a` | `1b11f6cd` | yes | |
| `gen-c0e96213` | `4cef80b4` | yes | |
| `gen-1b66bce2` | `96d2566` | yes | |
| `gen-49d96a25` | `d1263d85` | yes | |
| `gen-bc4e7242` | `357b4733` | yes | |
| `gen-4a9a8310` | `855712e3` | yes | |
| `gen-ff6b9237` | `2ac18d18` | yes | |
| `gen-ed562c6f` | `2f8b60ab` | yes | |
| `gen-c0588207` | `1c1d3ea2` | yes | |
| `gen-0b9fff5b` | `d4353eef` | yes | |
| `gen-3ac9e23f` | `0f14c2e4` | yes | |
| `gen-0e510772` | `db2de159` | yes | |
| `gen-3a57e757` | `d0acc8d1` | yes | |
| `gen-47cf3d8f` | `ee84c7b3` | no | `stale-parallel-battle`: a battle queued by a parallel page whose page went inactive still started |
| `gen-8ffba1d4` | `c93a1ec7` | no | |
| `gen-2d99dc69` | `df2d1c3e` | no | |
| `gen-cc709a6f` | `698094bd` | no | |
| `gen-37e18ded` | `60c9ea20` | no | |
| `gen-9553e885` | `7c81e5da` | no | |
| `gen-96239876` | `231d6a3f` | no | |
| `gen-0ff7c248` | `4bba234b` | no | |
| `gen-c27e2e51` | `fdc54ca0` | no | |
| `gen-462299c3` | `4e5d880d` | no | `variable-beyond-safe-integer`: `1e308` was stored and saved as is |
| `gen-c8ca2ce7` | `c2e55a03` | no | `transfer-to-unknown-map`: the transfer threw from the host |
| `gen-9570c570` | `08880fa4` | no | `route-through-marker`: a `blocks: false` marker stopped a walking event |

Every generation from `47cf3d8f` down is refused because compatibility
carries across generations and `0b9fff5b` changed how queued parallel
battles behave.
