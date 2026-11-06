// A process that takes the data root lock given as the first argument and keeps it until killed, for tests of locks left behind by a dead host.
import { acquireDataRootLock } from "../platform/data-root-lock.ts";

acquireDataRootLock(process.argv[2]!);
console.log("locked");
setInterval(() => {}, 1 << 30);
