import { inject } from "vitest";

/**
 * The snapshot the tool/HTTP tests run against (see global-setup.ts). `isReal` is true only for the real Rebrickable
 * snapshot; assertions that only hold for real data (completeness floors) must be gated on it with `it.runIf(isReal)`.
 */
export const dbPath: string = inject("snapshotPath");
export const isReal: boolean = inject("snapshotKind") === "real";
