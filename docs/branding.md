# Trestl identity

The mark is a trestle seen in perspective: one angled beam over two braced
supports. Keep its three separate shapes and the open counters in the supports.

`public/trestl-mark.svg` is the source artwork. The shared `Logo` component loads
this file for navigation, authentication, loading states, and roadmap presentations.
The mark uses Trestl rust (`#c45532`); the wordmark follows the interface text colour.

The mark has a 40:32 aspect ratio. Use it at 40 × 32 px normally and 30 × 24 px
in compact lockups. Preserve its proportions, leave space around it, and do not
add shadows, outlines, or separate colours to the supports.

Derived assets:

- `public/favicon.svg`: the same paths centred in a square view box.
- `public/favicon.png`: 32 × 32 px browser fallback.
- `public/apple-touch-icon.png`: 180 × 180 px icon on an ivory background.
- `public/trestl-icon.svg`: padded ivory icon artwork.
- `extensions/raycast/assets/icon.png`: 512 × 512 px rendering of that icon.

When changing the mark, regenerate these assets from its paths and update the
favicon revision in `index.html` to refresh cached icons. The shared `Logo`
component and website import the source artwork through their bundlers, so their
asset URLs refresh automatically when the SVG changes.
Inspect the 16 px favicon and 24 px compact logo as well as the full-size artwork.
