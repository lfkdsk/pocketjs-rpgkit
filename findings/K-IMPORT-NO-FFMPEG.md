# RPG Maker import without system ffmpeg

Publication branch: `fix/rpgmaker-import-without-ffmpeg`

## Verdict

RPG Maker imports no longer fail as a project when the `ffmpeg` executable
cannot be started. CLI and Desktop Studio use a bundled Ogg Vorbis decoder for
Ogg input; unsupported M4A/AAC and malformed streams are omitted one file at a
time with an actionable bilingual reason. Maps, events, images and successfully
decoded audio continue through publication. Browser Studio keeps its
lightweight no-audio import path and now explains that limitation and recovery
route in English and Chinese.

## Decoder and degradation design

- System `ffmpeg` remains the first choice. Its command line and PCM/QOA path
  are unchanged, so an installed decoder produces the same bytes as before.
- The fallback is entered only when starting the process throws. A process
  which starts but rejects the stream still follows the existing corrupt-media
  path; it is not silently retried through another decoder.
- Ogg input, including standard encrypted `.ogg_` deployment media, is decoded
  by the lazily loaded `stb-vorbis` module. Mono/stereo validation, deterministic
  mixing, signed-16 conversion and a Hann-windowed sinc resampler feed the
  existing QOA encoder.
- A present but undecodable file retains its source path, format and byte count
  in `audio-media.json` with `status: "corrupt"`, zero output bytes and the
  exact reason. A genuinely absent file retains the existing `missing` status.
- M4A/AAC remains `ffmpeg`-only. With no executable, its reason says that the
  built-in decoder supports Ogg Vorbis only and tells the user to install
  `ffmpeg` and put it on `PATH`, in both English and Chinese.
- A degraded CLI import exits 0 after printing per-file warnings. Usage errors
  still exit 2 and fatal source/destination/import errors remain nonzero.

The pinned dependency is `stb-vorbis@0.0.6`. Its package license is
Apache-2.0, it has no dependencies, and no GPL code enters the distributable.
Desktop builds copy its license into
`app/helper/stb-vorbis-LICENSE.txt`. The root lock change contains only the
package entry and public npm integrity value; a registry scan found no private
or internal host names.

## Output comparison

The committed two-second, 11.025 kHz mono Ogg tone was decoded once by the
existing `ffmpeg` command and once by the bundled decoder at the same target
format. Both produced 22,080 frames. The observed maximum signed-16 sample
difference was 12 and the signal-to-noise ratio was 69.63 dB. The regression
test deliberately allows a maximum difference of 64 and requires at least
60 dB, while requiring equal frame counts. This bounds decoder differences
without weakening the installed-`ffmpeg` byte-identity guarantee.

## Product surfaces

- `audio-media.json`, coverage output and CLI warnings carry the per-file
  reason without aborting the project.
- Desktop Studio ships the decoder and license, stages the complete import,
  shows the bilingual warning, publishes atomically, and opens the result.
- Browser Studio explicitly says that the page cannot invoke system `ffmpeg`,
  that Ogg/M4A audio is omitted while maps and images continue, and that
  Desktop Studio or the CLI can import it when `ffmpeg` is installed.
- The feature status and both importer guides now describe the fallback,
  M4A/AAC limit, CLI exit semantics and the desktop/browser distinction.

## Test evidence

### Focused regression suite

```text
bun test tests/rpgmaker-audio-media.test.ts tests/rpgmaker-no-ffmpeg.test.ts tests/rpgmaker-no-ffmpeg-cli.test.ts tests/studio-desktop-helper.test.ts tests/studio-rpgmaker-import-browser.test.ts
27 pass
0 fail
187 expect() calls
Ran 27 tests across 5 files. [18.19s]
```

This covers deterministic bundled decoding, encrypted `.ogg_`, installed
`ffmpeg` parity, per-file corrupt Ogg/M4A omission, bilingual reasons, an
absolute Bun executable with an empty child `PATH`, helper import, browser
bundle isolation and browser guidance.

### Empty-PATH end-to-end determinism

The fixture was imported twice with an absolute Bun executable and an empty
`PATH`. Each output contained 40 files and 491,259 bytes; a recursive byte
comparison was empty. Both runs reported 3 maps, 4 tile sheets and 12 sprites,
and each emitted six QOA files through the bundled decoder.

### Isolated mutations

Each mutation ran in its own temporary worktree and was removed afterward.

| Mutation | Focused result | Detection |
| --- | ---: | --- |
| Restore the old throw when `ffmpeg` cannot start | 0 pass, 3 fail | No-ffmpeg import is required to continue. |
| Remove the actionable decoder-unavailable reason | 2 pass, 1 fail | English/Chinese recovery guidance is required. |
| Feed encrypted Ogg bytes to the fallback without decrypting them | 2 pass, 1 fail | Encrypted deployment audio must decode successfully. |

### Acceptance gates

| Gate | Result |
| --- | --- |
| remove `dist/`, `bun run build:wasm` | exit 0; `pocketjs.wasm` 445,622 bytes |
| `bun run build:example` | exit 0 |
| `bunx tsc --noEmit` | exit 0 |
| `bun run test` | 4,723 pass, 0 fail, 0 skip; 732,724 assertions across 311 files in 523.50 s |
| `bun run web` | exit 0; all six web games built |
| `bun tools/studio-verify.ts` | `PASS`; browser import guidance, result opening, 287 requests with no failures, and a clean console |
| `cd studio-desktop && bun run build` | exit 0; Studio site, preview, main, preload and compiled helper ready |
| `cd studio-desktop && bun run e2e` under Xvfb | 11 pass, 0 fail, 0 skipped; real Electron import used a `PATH` without `ffmpeg`, emitted six Ogg assets, omitted one present M4A, showed bilingual guidance and opened the result |

## Visual review

The generated wide browser result (1440×900), compact Chinese browser result
(600×900 at 2× density), and desktop no-`ffmpeg` result were opened and checked
at original resolution. The ready state, coverage metrics, per-file reason,
warning affordance and Open result action are visible; the compact layout has
two metric columns with no horizontal clipping. The desktop image visibly
states that the built-in decoder supports Ogg Vorbis only and gives the
`ffmpeg`/`PATH` recovery in both languages.

## Repository hygiene

- `bun.lock` contains the one pinned public package and no internal registry
  address.
- Generated build directories and temporary decoder/Xvfb/test files are not
  committed.
- `git diff --check`, changed-file private-path scans, author checks and the
  no-merge history check pass.
- Commits use `lfkdsk <lfkdsk@gmail.com>` and contain no co-author footer.

subagent 使用：4 / 分别负责 Ogg fallback 与许可、浏览器警告、导入测试、Studio 桌面警告；并行实现与互审节省了时间 / 是

PASS
