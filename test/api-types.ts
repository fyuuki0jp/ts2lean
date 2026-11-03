import { expect } from "vitest";
import "../dist/vitest.js";
import type { LeanContract } from "../dist/types.js";
import { verifyFunction } from "../dist/runtime.js";

declare const integerFunction: (value: bigint) => bigint;
declare const integerContract: LeanContract<bigint, bigint>;
declare const booleanInput: LeanContract<boolean, bigint>;
declare const booleanOutput: LeanContract<bigint, boolean>;

await expect(integerFunction).toVerify(integerContract);
await verifyFunction<bigint, bigint>(integerFunction, integerContract);
// @ts-expect-error incompatible contract input
await expect(integerFunction).toVerify(booleanInput);
// @ts-expect-error incompatible contract output
await expect(integerFunction).toVerify(booleanOutput);

declare const reducer: (state: bigint, action: boolean) => bigint;
declare const reducerContract: LeanContract<{readonly state: bigint; readonly action: boolean}, bigint>;
await expect(reducer).toVerify(reducerContract);
await verifyFunction(reducer, reducerContract);
// @ts-expect-error incompatible multiple-argument return type
await expect(reducer).toVerify(booleanOutput);
// @ts-expect-error preserve single-argument input checking in runner-independent API
await verifyFunction(integerFunction, booleanInput);
