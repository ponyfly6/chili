# Chili Brand Assets

Canonical source files:

- `chili-icon.svg` is the transparent primary chili mark.
- `chili-icon-tile.svg` is the opaque dark app/avatar variant.
- `favicon.svg` and `favicon.ico` are browser favicon assets.

Committed PNG fallbacks are opaque, tile-backed images so they preview cleanly in file browsers and upload surfaces:

- `chili-icon-512.png`
- `chili-icon-128.png`
- `chili-icon-32.png`
- `chili-icon-16.png`
- `chili-icon-tile-512.png`

Regenerate PNGs from the opaque tile SVG:

```sh
for size in 512 128 32 16; do
  rsvg-convert -w "$size" -h "$size" chili-icon-tile.svg -o "chili-icon-${size}.png"
done
```

Regenerate the opaque app/avatar tile PNG:

```sh
rsvg-convert -w 512 -h 512 chili-icon-tile.svg -o chili-icon-tile-512.png
```

Regenerate the ICO fallback:

```sh
magick chili-icon-16.png chili-icon-32.png chili-icon-128.png favicon.ico
```
