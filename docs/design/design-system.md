# Trestl interface specification

> **Reference, not current behavior.** This specification and the [renders in this folder](README.md) came before the shipped app. The palette and the 240px sidebar width still match. The navigation does not: the workspace picker, the project tree and saved Views in the sidebar never shipped. The sidebar is being redesigned in [#89](https://github.com/saynain/trestl/issues/89).

Reference: workspace-concept.png, generated with the built-in image generation tool from the user's functional requirements. The app implementation extends this reference for required authentication, item discussion, forms, overview, settings, and narrow screens.

- Canvas warm white #fdfcf9; navigation warm paper #f6f4ef; borders #dedfd7; ink #242824; muted #70766d; primary burnt orange #b84a29. The logo uses #c45532; darker action text preserves contrast. Dark mode uses a light terracotta accent.
- Font native system sans, compact 13px controls, 25px/600 primary title, 12px metadata, 14px readable item prose. No external font dependency.
- Desktop: 240px left sidebar, 60px breadcrumb toolbar, 32px content gutters, 64px project icon and heading, tab rule, filter toolbar, grouped list rows of 44px. Responsive: mobile navigation drawer, simplified list columns, full-screen details.
- Lucide outline icons 16px, weight1.65; colored circular status indicators; initials avatars reflect actual users. No generated avatar portraits.
- Radius6 controls, radius8 dialogs, restrained shadows for floating surfaces only. No decorative image assets.
- Brand: lowercase trestl wordmark and an orange trestle symbol, on a dedicated row above the bordered workspace picker (the picker never shipped). The same symbol appears in authentication, roadmap presentations, browser icons and Raycast.
- Navigation (reference only; see the note above): Home, Inbox, My work, All projects; nested workspace project tree; saved Views; Settings. Project tabs Overview, Work items, Board, Resources. Actions New item, Filter, Search work items, Group by, Display, Add item.
- List group headers and table rows share column alignment. Item detail keeps discussion central and attributes to the right. Modal and keyboard focus states must be visible and accessible.
- Intentional functional deviations from reference: seed content reflects actual relative deadlines; actual user initials instead of fictional portraits; computed counts; status semantic colors; mobile reflow; additional controls only for requested functionality.

## Personal Home

Home extends the existing palette, navigation, controls and list patterns. It uses a 28px heading, a single bordered quick-capture form, four counted navigation tabs, and 72px task rows with readable 14px titles. Below 600px, capture controls wrap and row dates/actions move beneath the title. Existing theme tokens provide dark mode. Personal inbox remains the storage location; Home is a personal perspective over existing work items.
