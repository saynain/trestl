# Theme palettes

`t3-palettes.ts` is copied from [T3 Code's shared theme palettes](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/themePalettes.ts).
`t3-code.ts` contains the standard desktop palette from [themePalette.ts](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/themePalette.ts).
Retrieved September 14, 2026. Both are Copyright (c) 2026 T3 Tools Inc., MIT licensed; the full notice is in `T3-LICENSE`.

Trestl maps these original color roles to its CSS tokens. Its appearance preferences and editor are independent implementations. Theme JSON uses T3 Code's version 1 format, including optional opposite-mode variants. Unsupported color roles and nonliteral colors are rejected. This does not include the VS Code converter or marketplace search.

Preferences and custom palettes are stored per profile in this browser. Existing light/dark preferences migrate to the original Trestl palette. System mode follows live OS changes, and light/dark may select separate palettes. Excalidraw retains its existing independent canvas theme preference.

Catppuccin Mocha uses the [official Catppuccin palette](https://catppuccin.com/palette/#mocha), with mauve accents. It is available in dark mode and preserves the separately selected light theme. The Trestl logo retains its fixed brand color.
