export type Reply = {readonly ok:true; readonly value:bigint} | {readonly ok:false; readonly error:Problem};
export type Problem={readonly kind:"denied"}|{readonly kind:"conflict"};
export type Input={readonly allowed:boolean;readonly amount:bigint};
export interface Ports {
  readonly authorize:(input:Input)=>Promise<Reply>;
  readonly commit:(input:Input)=>Promise<Reply>;
}
type ProjectedReply = {readonly ok:true; readonly value:{readonly amount:bigint}} |
  {readonly ok:false; readonly error:Problem};
function projectReply(reply:Reply):ProjectedReply {
  if(!reply.ok)return reply;
  return {ok:true,value:{amount:reply.value}};
}
export function createService(ports:Ports) {
  async function save(input:Input):Promise<Reply> {
    const permission=await ports.authorize(input);
    if(!permission.ok)return permission;
    const saved=await ports.commit(input);
    if(!saved.ok)return saved;
    return {ok:true,value:input.amount};
  }
  async function authorizationHelper(input:Input):Promise<Reply> {
    return await ports.authorize(input);
  }
  async function saveViaHelper(input:Input):Promise<Reply> {
    const permission=await authorizationHelper(input);
    if(!permission.ok)return permission;
    const saved=await ports.commit(input);
    if(!saved.ok)return saved;
    return {ok:true,value:input.amount};
  }
  async function saveViaProjection(input:Input):Promise<Reply> {
    const permission=await ports.authorize(input);
    if(!permission.ok)return permission;
    const saved=await ports.commit(input);
    const projected=projectReply(saved);
    if(!projected.ok)return projected;
    return {ok:true,value:projected.value.amount};
  }
  return {save,saveViaHelper,saveViaProjection};
}
