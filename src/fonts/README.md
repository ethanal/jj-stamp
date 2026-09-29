# Source Code Pro

`SourceCodePro.ttf` is the unmodified upright variable font (weights 200–900) from Google Fonts, pinned to commit `bd62bd8b4715f007af6905b0c9fd030f8410b289`:

```text
https://raw.githubusercontent.com/google/fonts/bd62bd8b4715f007af6905b0c9fd030f8410b289/ofl/sourcecodepro/SourceCodePro%5Bwght%5D.ttf
SHA-256: b400fc584e10aff25d0e775ce181b4fc1c5ea1b5dc37b81aeb2084375b945790
```

Keep the full font rather than a Latin-only web subset: jj's graph needs its box-drawing glyphs to share the same metrics as spaces and revision text. Vite bundles the font as a content-hashed asset; no Google Fonts request occurs at runtime.

The SIL Open Font License and copyright notice from the same upstream commit are in `public/fonts/source-code-pro/OFL.txt`, copied into the distributed browser assets by Vite.
