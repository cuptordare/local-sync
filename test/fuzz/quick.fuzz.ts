// A quick randomized run for every change (`npm run test:fuzz`). See sync-fuzz.ts.
import { defineFuzzSuite } from "./sync-fuzz.js";

defineFuzzSuite(25);
