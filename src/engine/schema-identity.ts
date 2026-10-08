// src/engine/schema-identity.ts — which project-schema generations a sharded
// shell or save may name.
//
// A sharded shell and every save taken from it record the schema identity
// they were produced under (`mapSchemaHash`, `content.schema`). The identity
// is SHA-256 over canonical src/data/schema.json, so every schema edit,
// however small, yields a new one. Most v1 edits only add optional fields,
// commands or conditions: a document written for the older schema is still
// valid under the new one and means the same thing, and the runtime keeps
// accepting it. Those predecessors are listed here.
//
// Rules for changing this file when schema.json changes:
// - A purely additive change (every older document still validates and
//   behaves identically: a new optional property, a new command/condition
//   variant, a new enum value, a loosened limit) moves the outgoing
//   MAP_SCHEMA_HASH to the top of MAP_SCHEMA_COMPATIBLE_HASHES with a note.
// - Anything else (a new required field, a removed or tightened value, an
//   existing field that now behaves differently) is a new generation: clear
//   the list. Older shells and saves are then refused until a migration
//   exists. Note the break in src/data/CHANGELOG.md.
// tests/schema-compat.test.ts enforces that each schema edit takes one of
// these two paths.

/** SHA-256 of canonical src/data/schema.json. A test derives it from the file
 * so schema edits cannot leave it stale; keeping the literal avoids hashing
 * the schema at startup. */
export const MAP_SCHEMA_HASH = "70564328ea0fd8a8028ac6f360f82dda0973a068ad54f4a705fb3a3cd5531905";

/** Earlier schema identities whose shells and saves remain loadable, newest
 * first. Each entry names the change that superseded it.
 *
 * History of cleared lists (each break refuses every identity before it):
 * - `49d96a25…` → current only added optional parallax and animation timing
 *   data, their commands, and the `mapAnim` `this` target, so it is listed.
 * - `bc4e7242…` → current only added the optional project `worldTraversal`
 *   identity and the optional transfer `handoff` provenance, so it is listed.
 * - `4a9a8310…` → `bc4e7242…` only added the optional root `uiText` table, so
 *   it is listed.
 * - `ff6b9237…` → `4a9a8310…` only added RPG Maker-compatible picture, timer,
 *   map-scroll, number-input, scene-host, name and map-name-display commands,
 *   a timer condition, and the optional `system.mapNameDisplay` field, so it
 *   is listed.
 * - `ed562c6f…` → `ff6b9237…` only added commands (`loop`, `break`), a trigger
 *   (`eventTouch`) and an optional system field (`textVariables`), so it is
 *   listed.
 * - `c0588207…` → `ed562c6f…` only added optional world layout data, so it
 *   is listed.
 * - `0b9fff5b…` → `c0588207…` only added an optional field, so it is listed.
 * - `47cf3d8f…` → `0b9fff5b…` added the `scene` command, but the same change
 *   made a parallel page's queued battle drop when the page stops being
 *   active before the battle starts; older documents that relied on the
 *   battle still starting behave differently.
 * - `462299c3…` → `c27e2e51…` clamps numeric variable writes to safe
 *   integers, and saves holding larger numbers are refused.
 * - `c8ca2ce7…` → `462299c3…` turns a transfer to an unknown map from a
 *   thrown host error into the frozen content-error state.
 * - `9570c570…` → `c8ca2ce7…` made `blocks: false` events stop blocking
 *   character movement.
 * tests/fixtures/schema-compat keeps a refused fixture and a recorded
 * counterexample for each of these. */
export const MAP_SCHEMA_COMPATIBLE_HASHES: readonly string[] = Object.freeze([
  // superseded by: optional `nameInput.random`, `appearance.combatSheet` and
  // `system.characterNames`, plus event/variable forms of `changeName`;
  // older documents use none of them and retain literal `{char:...}` text
  "c5d8a3f0ed118bfd8d99f2a0b4dda7479918506c3728d09097f1ef662788af2c",
  // superseded by: the `playerMoving` condition and optional exact
  // `intervalTicks` on command-started wander; older documents never carry
  // either addition and retain their existing behavior
  "e763f4898c37c59c111618d57feb35d93b4ba67932cfb2094406388f1efedb45",
  // superseded by: optional save-runtime feedback entries in `uiText`;
  // older documents never carry them and keep the same English defaults
  "11227c99d75fe0ec833b77499bec30022f046383c4eeb9349a3f590bbc4ce801",
  // superseded by: the optional switch declaration `writtenBy: "host"` —
  // marks a switch the host or an extension writes at runtime, so the
  // static checker skips its read-never-set warning; older documents never
  // carry the field and behave identically
  "dddabaa88780fa1e117a911c88e191b5958bd390b41739e8b6bc1fd0f41ed4e0",
  // superseded by: the `routeSpeed` moveControl variant — a speed grade
  // scoped to one forced route; older documents never use it
  "a749a871f1eb32969ae58ff186871e21ff1ca4fb26390088512ee2bca927f82a",
  // superseded by: optional editor-facing switch and variable declarations;
  // undeclared ids keep their existing sparse-bank runtime semantics
  "1127febbfb43f2f33b1bd7a2df8c554efbbdc56e1e9a35f26558dbda4f8261b9",
  // superseded by: optional `text` layout fields (`position`, `align`,
  // `valign`, `background`); a text without them draws the same box
  "5f14109a6414a63f6a4eaaa25c586aca61218b3a8e53f4f3776853a9573e7349",
  // superseded by: the `autosave` command and optional `save.autosave`
  // interface label
  "c0e962138a1f12dc5627590869b99f7c9b2ced3040e3d05ed0ebd663142d4857",
  // superseded by: optional `system.textTokens` — declaring it is the
  // explicit opt-in that switches `{x:<key>}` expansion on (the key
  // allowlist a game's session resolver answers); a document without it
  // keeps the pre-{x:} literal behavior, so the change is additive
  "3315cbf7af3ceb5f6690824bf7fe0d0d7ac90f080fd741c7e24159a2b3e99ddb",
  // superseded by: the optional label `ord` (flat RPG Maker source index, so
  // a jumpLabel resolves the first label in source order even when the
  // importer reordered branches)
  "1b66bce2dff2f3f8476a9dcc3212ee826053447c5a7683c9942adbcfd122fc12",
  // superseded by: the KRM3 fixes — map `tiles` (four raw tile layers for
  // Get Location Info), item `kind` (weapon/armor exclusion), locationInfo
  // layer 0..3
  "3a57e757f9f5d4f3da13529cd376ceb8ef50a354a3a618e45a8fa41641b84562",
  // superseded by: optional parallax/timing data, commands, and mapAnim `this`
  "0e510772cbf540414553fd8f4204e0cecba80f4d8c844146e3be46d23841daae",
  // superseded by: KRM3 label/jumpLabel, selectItem, menu/save access,
  // locationInfo, stopSe, region condition, map regions/terrain, item type
  "3ac9e23fa3289a6021dfe4e0141e732b303aefad37c2ba70538423701f00156e",
  "49d96a259da5a5bae6f15eb0c3e7184e8f874de1b0f13a8ba161586f4c0149a1",
  // superseded by: optional project traversal identity and transfer handoff provenance
  "bc4e72429a7ed9f491dcddf7a9b6bbd5ef8216d2521721ad1c078cabccf26906",
  // superseded by: optional root `uiText`
  "4a9a831002d95a662f16c83de31dea57998ae72b7c2183d5433eabd932f4c4a1",
  // superseded by: KRM2 picture/timer/system commands and optional system.mapNameDisplay
  "ff6b923750b1078d15a8d2443251d14a5b5b17055b88445515a9b34e38056611",
  // superseded by: `loop` / `break` commands, `eventTouch` trigger, `system.textVariables`
  "ed562c6fa8e20c0d0d20a755e19b49581b49127328343c87231801a19f297de2",
  // superseded by: optional `worldLayout` project data
  "c0588207c28d2ffcec9e2ac981f9859ca55576fb7dc53f221466c249d07bfa06",
  // superseded by: optional `icon` on choices options
  "0b9fff5b478b87e0dcae1f37044a444043c735339ca45245bdbbb9e2e36e7ab5",
]);

/** True when the current runtime accepts shells and saves that name `hash`. */
export function isCompatibleMapSchemaHash(hash: string): boolean {
  return hash === MAP_SCHEMA_HASH || MAP_SCHEMA_COMPATIBLE_HASHES.includes(hash);
}

/** Explains why `hash` is refused by this runtime, for shell and save errors. */
export function describeMapSchemaRefusal(hash: string): string {
  const short = (h: string) => `${h.slice(0, 8)}…`;
  const accepted = [MAP_SCHEMA_HASH, ...MAP_SCHEMA_COMPATIBLE_HASHES].map(short).join(", ");
  return `schema ${short(hash)} is not one this runtime reads (it reads ${accepted}); ` +
    "it comes from before a breaking format change or from a different RPG Kit build, " +
    "see Schema identities in the rpgkit-project CHANGELOG";
}
