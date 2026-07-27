import type {
	createBroadcastChannelTab,
	createEnvelope,
	createIndexedDBAdapter,
	createMultiTabSync,
	createNetworkStatus,
	MultiTabSync,
} from "../../../src/index.js";

declare global {
	interface Window {
		__ls: {
			createIndexedDBAdapter: typeof createIndexedDBAdapter;
			createEnvelope: typeof createEnvelope;
			createNetworkStatus: typeof createNetworkStatus;
			createMultiTabSync: typeof createMultiTabSync;
			createBroadcastChannelTab: typeof createBroadcastChannelTab;
		};
		__lsReady: boolean;
		__net: ReturnType<typeof createNetworkStatus>;
		__netEvents: boolean[];
		__tab: MultiTabSync<unknown>;
		__received: Array<{ message: unknown; fromTabId: string }>;
		__became: boolean;
	}
}
