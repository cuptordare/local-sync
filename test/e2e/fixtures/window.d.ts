import type {
	createBroadcastChannelTab,
	createIndexedDBAdapter,
	createLocalSyncApp,
	createNetworkStatus,
	KeyValueStore,
	LocalSyncApp,
	TabChannel,
} from "../../../src/index.js";

declare global {
	interface Window {
		__ls: {
			createIndexedDBAdapter: typeof createIndexedDBAdapter;
			createNetworkStatus: typeof createNetworkStatus;
			createBroadcastChannelTab: typeof createBroadcastChannelTab;
			createLocalSyncApp: typeof createLocalSyncApp;
		};
		__lsReady: boolean;
		__net: ReturnType<typeof createNetworkStatus>;
		__netEvents: boolean[];
		__channel: TabChannel;
		__received: unknown[];
		__app: LocalSyncApp;
		__items: KeyValueStore<{ text: string }>;
		__reads: number;
	}
}
