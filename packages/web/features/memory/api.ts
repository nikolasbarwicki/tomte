import type { MemoryUpdate } from "@tomte/contract/api";

import { act } from "@/host/api.ts";

/** Replaces one memory file; the host streams the new text back as a `memory` event. */
export const saveMemory = (update: MemoryUpdate) => act("/api/memory/update", update);
