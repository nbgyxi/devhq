# Isolated tool host protocol

DevHQ tools run one at a time in a disposable child WebView2 environment. The
main renderer owns navigation, search, pins, pop-out, status, and recovery.
A tool must never add those controls to its body.

## Header ownership

The shell header is infrastructure. It contains only tool identity and the
shared Back, Pop out, Pin, and Close controls. A tool must not place feature
actions in that header.

Feature actions belong to the tool and must be designed into its content. For
example, refresh belongs beside the data it refreshes, export belongs beside
the exportable result, and start/stop belongs beside the activity it controls.
When migrating an existing tool, move each custom header action deliberately
into an appropriate toolbar, panel, empty state, or contextual action area in
that tool. Do not use a host adapter that automatically extracts, relocates, or
recreates unknown header buttons.

This migration is intentionally performed one tool at a time. Removing the
legacy header is complete only after every custom action has an intentional
home in both embedded and pop-out layouts.

## Tool module contract

A standalone module exposes one global API; tool families may expose one API
for their catalog:

```js
window.devhqExample = {
  mount(host),          // build inside host only
  opened?.(),           // start/refresh optional data work
  render?.(),           // redraw after state/context changes
  exportState?.(),      // return structured-clone/JSON-safe state
  importState?.(state), // accept state before mount
};
```

Modules do not access the parent document. Existing modules use the compatible
`window.devhqShell` facade. New modules may use `window.devhqToolBridge`.

## Bridge v1

`window.devhqToolBridge` provides:

- `id`, `session`, and `protocol`
- `ready`: context promise
- `context()`: tool metadata, theme, pin/pop-out state, and project snapshots
- `request(action, value)`: correlated request to the parent shell
- `attach(api)`: attach the lifecycle API
- `persist()` / `takeState()`: Rust-backed state across WebView environments
- `reportReady()`: report that mount and initial loading completed

Supported parent actions are `navigate`, `toggle-pin`, `pop-out`, `confirm`,
and `search`. Every request carries the random session token and is ignored if
it does not match the shell's active isolated session.

## Failure guarantees

- Tool code receives only the body rectangle.
- Back, Close, Home, Search, Pin, and Pop out remain in the parent renderer.
- Leaving closes the native child without consulting its JavaScript.
- Each tool gets a separate WebView2 data directory/environment.
- State handoff uses Rust memory, never cross-environment browser storage.
- A hung tool may lose at most the state since its last periodic bridge save.

## Adding a tool

Add metadata to the shell registry, expose the lifecycle API, and add a module
entry to `src/tool-embedded.js` only when it is a new standalone module. Tools
inside the existing utility or Windows catalogs need no loader or shell change.
