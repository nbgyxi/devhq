/**
 * Fake `window.__TAURI__` injected into the page before any app script
 * runs, so the front end can be exercised in a plain headless browser with
 * no Tauri runtime, no built app, and no OS-level driver at all.
 *
 * This is a *generic* stub, not a faithful mock of any real command:
 *   - core.invoke(command) never rejects; it guesses a shape from the
 *     command name (list-ish commands get [], everything else gets {}).
 *   - event.listen/emit are no-ops that resolve.
 *   - window.getCurrentWindow() returns a Proxy where every method call
 *     resolves to a sensible default, so app.js's `appWindow.isMaximized()`,
 *     `.onResized(cb)`, etc. all work without hand-listing every method the
 *     window object exposes across every file.
 *
 * This is enough for most screens, whose invoke calls are already wrapped
 * in try/catch or optional chaining (confirmed across app.js /
 * windows-tools.js / util-tools.js) and treat "got nothing back" as an
 * empty state rather than crashing. A screen that assumes a specific field
 * exists on a command's result can still throw - see scripts/e2e/README.md's
 * "what this misses" section for what that means for this suite.
 *
 * Exposed as a source string (not a function) because it's handed straight
 * to Playwright's page.addInitScript(), which needs literal source rather
 * than a closure over this module's scope.
 */
"use strict";

const LIST_HINT_SOURCE = "(list|scan|rows|catalog|drives|events|entries|sessions|history|tools|projects|ports|processes|devices|clips|repos|branches|commits|logs)";

function stubSource() {
  return `(() => {
    const LIST_HINT = /${LIST_HINT_SOURCE}/i;
    function guessInvokeResult(command) {
      return LIST_HINT.test(command) ? [] : {};
    }
    function autoStubWindow() {
      const knownAsync = {
        isMaximized: false, isMinimized: false, isFullscreen: false,
        isFocused: true, isVisible: true, theme: "dark",
      };
      return new Proxy({}, {
        get(target, prop) {
          if (typeof prop !== "string" || prop === "then") return undefined;
          if (prop in knownAsync) return () => Promise.resolve(knownAsync[prop]);
          // Anything that looks like a subscription (onResized, onMoved,
          // onCloseRequested, listen, ...) resolves to an unlisten fn.
          if (/^on[A-Z]/.test(prop) || prop === "listen") return () => Promise.resolve(() => {});
          return () => Promise.resolve(undefined);
        },
      });
    }
    window.__TAURI__ = {
      core: {
        invoke: (command) => Promise.resolve(guessInvokeResult(String(command || ""))),
      },
      event: {
        listen: () => Promise.resolve(() => {}),
        emit: () => Promise.resolve(),
      },
      window: {
        getCurrentWindow: () => autoStubWindow(),
      },
    };
  })();`;
}

module.exports = { stubSource };
