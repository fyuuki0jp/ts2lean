import { expect } from "vitest";
import { verifyFunction, verifySystem } from "./runtime.js";
import type { LeanContract, VerificationOptions } from "./types.js";

expect.extend({
  async toPreserveInvariant(
    received: Record<string, Function>,
    contract: LeanContract,
    options?: VerificationOptions,
  ) {
    if (this.isNot)
      throw new Error(
        "toPreserveInvariant does not support .not: unproved is not a counterexample.",
      );
    await verifySystem(received, contract, options);
    return {
      pass: true,
      message: () =>
        "Lean proved the system invariant under the reported module assumptions.",
    };
  },
  async toVerify(
    received: unknown,
    contract: LeanContract,
    options?: VerificationOptions,
  ) {
    if (this.isNot) {
      throw new Error(
        "toVerify does not support .not: failure to prove a contract is not proof that it is false.",
      );
    }
    await verifyFunction(
      received as (input: unknown) => unknown,
      contract,
      options,
    );
    return {
      pass: true,
      message: () =>
        "Lean verified the imported function against its contract.",
    };
  },
});

declare module "vitest" {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > {
    toPreserveInvariant(
      contract: LeanContract,
      options?: VerificationOptions,
    ): Promise<void>;
    toVerify(
      contract: T extends (input: infer I) => infer O
        ? LeanContract<I, O>
        : LeanContract,
      options?: VerificationOptions,
    ): Promise<void>;
  }
}

export { verifyFunction, verifySystem, VerificationError } from "./runtime.js";
