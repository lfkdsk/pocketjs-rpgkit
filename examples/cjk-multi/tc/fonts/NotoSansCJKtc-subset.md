# Noto Sans CJK TC subset

`NotoSansCJKtc-subset.otf` is the fallback face for this app's Traditional Chinese text. The PocketJS build
reads `../fonts.json`, which lists this font as a fallback and `cjk-charset.txt` as a
character file, so every listed character is baked into the app's font atlases from this face.

- Source: [NotoSansCJKtc-Regular.otf](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf)
  at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`.
- Source SHA-256: `dce08bd4fd91aa8aa76ed8fea4b694c2dfb8550f67871e326843212ddbeb88b4` (16435884 bytes).
- Characters: 121 (the characters of this app's text that Inter does not map).
- Subset size: 36772 bytes.

Each glyph keeps the source advance width and outline at the source units per em, and the
font keeps the source ascender and descender, so baked advances match the full font.
Hinting and OpenType layout tables are not carried over.

Regenerate after the app's text changes (the source font is downloaded once and cached):

```sh
bun tools/cjk-font.ts --app=<app dir> [--scan=<project file> ...] --variant=tc
```

Add `--check` to verify, without network access, that the committed subset covers the text.

The font is licensed under the SIL Open Font License 1.1; the copyright notice and the
license text are in `LICENSE-NotoSansCJK.txt`. `../pak.json` ships that file inside the app's pak
as `license:NotoSansCJK.txt`, and the web and desktop packaging tools copy it beside the build.
The subset is a Modified Version under that license and is renamed "Noto Sans CJK TC Subset".
