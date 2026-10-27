/** Where the setup project keeps each demo login's signed-in browser state. A plain module, so specs can import it. */
export const STATE = { manager: 'e2e/.auth/manager.json', frontdesk: 'e2e/.auth/frontdesk.json', cedarpark: 'e2e/.auth/cedarpark.json' };
/**
 * The demo API's provisioning token in this suite only (playwright.config.ts passes it), so a spec can open a new,
 * empty clinic as the hosting layer would. Made up; a deployment sets its own, and the demo has none unless given one.
 */
export const E2E_PROVISIONING_TOKEN = 'e2e-only-provisioning-token-not-a-secret-0001';
