import {
	createBroadcastChannelTab,
	createIndexedDBAdapter,
	createLocalSyncApp,
	createNetworkStatus,
} from "localsync";

// Exposed for Playwright's page.evaluate() -- see test/e2e/fixtures/*.spec.ts.
window.__ls = {
	createIndexedDBAdapter,
	createNetworkStatus,
	createBroadcastChannelTab,
	createLocalSyncApp,
};
window.__lsReady = true;
