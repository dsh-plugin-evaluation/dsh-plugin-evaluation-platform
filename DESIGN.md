# DSH Evaluation Platform UI

## Direction

An operational console with a quiet dark graphite canvas, amber run-state accents, and compact monospace metadata. The surface prioritizes scanability and explicit state over decoration.

## Tokens

- Canvas: `#111318`; panel: `#191d24`; elevated panel: `#222832`.
- Text: `#f4f1ea`; muted text: `#9ba4b2`; border: `#303846`.
- Accent: `#f0a84b`; success: `#71d39a`; danger: `#f17d7d`.
- Spacing uses 4px increments; controls use 8px radius.
- System font stack for portability; monospace for IDs, paths, and status labels.

## Primitives

- `card`: grouped operational information with a title and muted description.
- `status-pill`: compact state indicator using success, warning, and danger tokens.
- `action-button`: explicit action with visible disabled and focus states.
- `data-list`: responsive rows for plugins, sources, runs, and reports.

## Interaction

- Refresh is explicit and idempotent.
- Run submission shows a pending state and then updates from the API.
- Cancellation is only offered while a run is active.
- Reduced-motion users receive no transitions.

## Accessibility

- One page heading and labelled form controls.
- Buttons expose their action text; status is announced through `aria-live`.
- Color is never the sole state signal.
