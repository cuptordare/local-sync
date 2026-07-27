import {
	createBroadcastChannelTab,
	createEnvelope,
	createIndexedDBAdapter,
	createMultiTabSync,
	createNetworkStatus,
} from "@localsync";

// Exposed for Playwright's page.evaluate() -- see test/e2e/fixtures/*.spec.ts.
window.__ls = {
	createIndexedDBAdapter,
	createEnvelope,
	createNetworkStatus,
	createMultiTabSync,
	createBroadcastChannelTab,
};
window.__lsReady = true;
