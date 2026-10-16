// A long randomized run, for before a release or after changing sync code
// (`npm run test:fuzz:long`). See sync-fuzz.ts.
import { defineFuzzSuite } from "./sync-fuzz.js";

defineFuzzSuite(500);
