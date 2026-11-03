import type {Input,Reply,Ports} from "./service";
export function mutations(ports:Ports) {
  async function noAuthorization(input:Input):Promise<Reply> {
    return await ports.commit(input);
  }
  async function noCommit(input:Input):Promise<Reply> {
    const permission=await ports.authorize(input);
    if(!permission.ok)return permission;
    return {ok:true,value:input.amount};
  }
  async function wrongOrder(input:Input):Promise<Reply> {
    const saved=await ports.commit(input);
    if(!saved.ok)return saved;
    const permission=await ports.authorize(input);
    if(!permission.ok)return permission;
    return saved;
  }
  async function twice(input:Input):Promise<Reply> {
    const permission=await ports.authorize(input);
    if(!permission.ok)return permission;
    await ports.commit(input);
    return await ports.commit(input);
  }
  async function unawaited(input:Input):Promise<Reply> {
    ports.authorize(input);
    return await ports.commit(input);
  }
  async function nestedAwait(input:Input):Promise<Reply> {
    return input.allowed ? await ports.commit(input) : await ports.authorize(input);
  }
  return {noAuthorization,noCommit,wrongOrder,twice,unawaited,nestedAwait};
}
