// SPDX-License-Identifier: AGPL-3.0-only
// Loaded into the demo API with `node --import` when the suite runs with E2E_CLOCK (see playwright.config.ts):
// the server's clock runs E2E_CLOCK_OFFSET milliseconds away from the real one, so the demo seeds its visits
// around that moment and every "now" after agrees with the browser's. Nothing changes without the variable.
const offset = Number(globalThis.process?.env.E2E_CLOCK_OFFSET ?? 0);
if (offset) {
  const Real = Date;
  class Shifted extends Real {
    constructor(...args) {
      if (args.length === 0) super(Real.now() + offset);
      else super(...args);
    }
    static now() { return Real.now() + offset; }
  }
  globalThis.Date = Shifted;
}
