// Observation codec only: never evaluates the compiler IR or predicts behavior.
export const leanName = (name) =>
  name
    .split(".")
    .map((n) => `«${n}»`)
    .join(".");
export function encodeInput(shape, value) {
  if(shape.kind==="safeinteger") {
    if(typeof value!=="number"||!Number.isSafeInteger(value))throw Error("Outside safe-integer number domain");
    return `({value := ${String(value)}, negativeZero := ${Object.is(value,-0)}} : Ts2Lean.SafeInteger)`;
  }
  if(shape.kind==="snapshot") {
    if(!value||!Number.isSafeInteger(value.identity)||value.identity<0)throw Error("Invalid snapshot identity");
    return `({identity := ${value.identity}, json := ${encodeInput({kind:"optional",element:{kind:"jsstring"}},value.json)}} : Ts2Lean.Snapshot)`;
  }
  if(shape.kind==="optional")return value===undefined?`(none : Option ${observationType(shape.element)})`:`(some ${encodeInput(shape.element,value)})`;
  if(shape.kind==="array") {
    if(!Array.isArray(value)||Object.keys(value).length!==value.length)throw Error("Expected a dense array");
    return `([${value.map(v=>encodeInput(shape.element,v)).join(",")}] : List ${observationType(shape.element)})`;
  }
  if (shape.kind === "jsstring") {
    if (typeof value !== "string") throw Error("Invalid string");
    return `({units := [${Array.from({length:value.length}, (_, i) => value.charCodeAt(i)).join(",") }]} : Ts2Lean.JSString)`;
  }
  if (shape.kind === "int") {
    if (typeof value !== "string" || !/^(-?[1-9][0-9]*|0)$/.test(value))
      throw Error("Invalid decimal integer");
    return `(${value}:Int)`;
  }
  if (shape.kind === "bool") {
    if (typeof value !== "boolean") throw Error("Invalid boolean");
    return String(value);
  }
  if (shape.kind === "literal") {
    if (value !== shape.value) throw Error("Invalid literal");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid record");
  if (shape.kind === "union") {
    const v = shape.variants.find((v) => v.tag === value[shape.tag]);
    if (!v) throw Error("Invalid tag");
    if (Object.keys(value).length !== v.fields.length + 1)
      throw Error("Unexpected union fields");
    return `(${leanName(v.constructor)} ${v.fields.map((f) => encodeInput(f.shape, value[f.name])).join(" ")})`;
  }
  if (shape.kind !== "record") throw Error("Unsupported observation shape");
  if (Object.keys(value).length !== shape.fields.length)
    throw Error("Unexpected record fields");
  return `({${shape.fields.map((f) => `${leanName(f.name)} := ${encodeInput(f.shape, value[f.name])}`).join(",")}}:${leanName(shape.lean)})`;
}
export function leanObservation(shape, expr, depth = 0) {
  if(shape.kind==="safeinteger")return `(Lean.Json.arr #[Lean.toJson (toString ((${expr}).value)), Lean.toJson ((${expr}).negativeZero)])`;
  if(shape.kind==="snapshot")return `(Lean.Json.mkObj [("identity",Lean.toJson ((${expr}).identity)),("json",${leanObservation({kind:"optional",element:{kind:"jsstring"}},`(${expr}).json`,depth+1)})])`;
  if(shape.kind==="optional")return `(match ${expr} with | none => Lean.Json.null | some o${depth} => ${leanObservation(shape.element,`o${depth}`,depth+1)})`;
  if(shape.kind==="array")return `(Lean.Json.arr ((${expr}).map (fun o${depth} => ${leanObservation(shape.element,`o${depth}`,depth+1)})).toArray)`;
  if (shape.kind === "jsstring") return `(Lean.toJson ((${expr}).units.map UInt16.toNat))`;
  if (shape.kind === "int") return `(Lean.toJson (toString (${expr})))`;
  if (shape.kind === "bool" || shape.kind === "literal")
    return `(Lean.toJson (${expr}))`;
  if (shape.kind === "union")
    return `(match ${expr} with ${shape.variants
      .map((v) => {
        const names = v.fields.map((_, i) => `o${depth}_${i}`);
        return `| ${leanName(v.constructor)} ${names.join(" ")} => Lean.Json.mkObj [(${JSON.stringify(shape.tag)},Lean.toJson ${JSON.stringify(v.tag)})${v.fields.map((f, i) => `,(${JSON.stringify(f.name)},${leanObservation(f.shape, names[i], depth + 1)})`).join("")}]`;
      })
      .join(" ")})`;
  if (shape.kind === "record")
    return `(Lean.Json.mkObj [${shape.fields.map((f) => `(${JSON.stringify(f.name)},${leanObservation(f.shape, `(${expr}).${leanName(f.name)}`, depth + 1)})`).join(",")}])`;
  throw Error("Unsupported observation shape");
}
function observationType(shape) {
  if(shape.kind==="array")return `(List ${observationType(shape.element)})`;
  if(shape.kind==="optional")return `(Option ${observationType(shape.element)})`;
  return ({int:"Int",bool:"Bool",jsstring:"Ts2Lean.JSString",safeinteger:"Ts2Lean.SafeInteger",snapshot:"Ts2Lean.Snapshot",unit:"Unit"})[shape.kind]??leanName(shape.lean);
}
// Canonical JSON compares objects independent of serializer key order.
export const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export function shrinkInputs(shape, input) {
  if (shape.kind === "int") {
    const n = BigInt(input),
      abs = n < 0n ? -n : n;
    return [...new Set(["0", "1", "-1", String(n / 2n)])].filter((x) => {
      const v = BigInt(x);
      return (v < 0n ? -v : v) < abs;
    });
  }
  if (shape.kind === "bool") return input ? [false] : [];
  const fields =
    shape.kind === "record"
      ? shape.fields
      : shape.kind === "union"
        ? shape.variants.find((v) => v.tag === input[shape.tag]).fields
        : [];
  return fields.flatMap((f) =>
    shrinkInputs(f.shape, input[f.name]).map((value) => ({
      ...input,
      [f.name]: value,
    })),
  );
}

export async function minimizeInput(shape, input, fails) {
  for (;;) {
    let changed = false;
    for (const candidate of shrinkInputs(shape, input)) {
      if (await fails(candidate)) {
        input = candidate;
        changed = true;
        break;
      }
    }
    if (!changed) return input;
  }
}
