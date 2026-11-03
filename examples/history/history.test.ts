import {expect,test} from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import {createHistory,transitionHistory} from "./history";
import {create,step,bounded,bounded50} from "./History.lean";

test("the actual initializer establishes the machine initial states",async()=>{
  await expect(createHistory).toVerify(create);
});
test("history edits preserve exact snapshots and their order",async()=>{
  await expect(transitionHistory).toVerify(step);
});
test("every finite history at horizon 80 preserves the bound and access safety",async()=>{
  await expect(transitionHistory).toPreserveInvariant(bounded);
});
test("every finite history at horizon 50 preserves the bound and access safety",async()=>{
  await expect(transitionHistory).toPreserveInvariant(bounded50);
});
