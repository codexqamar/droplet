# DROPLET portal design system

## Intent

DROPLET is a trade operations workspace for approved account staff. The interface prioritises catalogue lookup, ordering, order history, quotes, and account statements. Its tone is quiet, technical, and assured.

## Structure

- Workbench application shell: persistent top bar and bottom dock, with one focused workspace per route.
- Routes: Dashboard, Quick order, Catalogue, Orders, Quotes, Statements.
- Dashboard is an overview; full datasets and primary actions live on their dedicated pages.
- Web and desktop use the same components and route model.

## Material

- No gradients.
- Neutral base canvas with translucent, backdrop-filtered surfaces.
- Three material weights: navigation, primary panel, inset control.
- Depth comes from transparency, blur, a fine inner highlight, and restrained shadow—not colored bloom.
- Avoid stacked translucent cards where a divider or flat inset surface is clearer.

## Color

- Apple blue is the brand/action anchor. Light mode uses `#007aff`; dark mode uses `#0a84ff` on the original cool navy canvas.
- Green, amber, and red remain reserved for status.
- Text and borders use neutral greys with sufficient contrast.

## Typography

- Inter Variable for interface and display copy.
- JetBrains Mono only for identifiers, SKUs, order numbers, and tabular technical values.
- Compact, sentence-case headings. No promotional copy inside the portal.

## Motion

- Motion is functional and brief: opacity and transform only.
- No bouncing, looping decoration, or staged page reveals.
- Respect `prefers-reduced-motion`.

## Copy

- State what happened and the next useful action.
- Do not refer to interface location (for example, “the banner above”).
- Do not expose transport or backend errors verbatim.
- Empty states explain what the dataset represents and point to a relevant action only when one exists.

## Responsive behavior

- Dock labels remain single-line and horizontally scroll only when the viewport cannot contain them.
- Data tables collapse into readable cards on narrow screens.
- All interactive targets are at least 44px on touch devices.
- `html` and `body` use `overflow-x: clip`.

## Hallmark

Macrostructure: Workbench. Genre: product operations, modern-minimal with an explicit Liquid Glass exception. Accent: Apple blue. Enrichment: none. Navigation: floating dock. Footer: none; application shell.
