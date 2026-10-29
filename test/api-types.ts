import { expect } from "vitest";
import "../dist/vitest.js";
import type { LeanContract } from "../dist/types.js";

declare const integerFunction: (value: bigint) => bigint;
declare const integerContract: LeanContract<bigint, bigint>;
declare const booleanInput: LeanContract<boolean, bigint>;
declare const booleanOutput: LeanContract<bigint, boolean>;

await expect(integerFunction).toVerify(integerContract);
// @ts-expect-error incompatible contract input
await expect(integerFunction).toVerify(booleanInput);
// @ts-expect-error incompatible contract output
await expect(integerFunction).toVerify(booleanOutput);
