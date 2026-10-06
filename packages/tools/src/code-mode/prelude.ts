/** This source runs inside QuickJS. The host bridge is reachable only by these closures. */
export const CODE_MODE_PRELUDE = `(function (bridge, catalogJson) {
  "use strict";
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const then = Promise.prototype.then;
  const ErrorCtor = Error;
  const pending = new Map();
  let nextId = 1;
  let finished = false;
  const tools = Object.create(null);
  const catalog = parse(catalogJson);
  function fail(error) {
    if (finished) return;
    finished = true;
    let message;
    try { message = error instanceof ErrorCtor ? error.name + ": " + error.message + (error.stack ? "\\n" + error.stack : "") : String(error); }
    catch { message = "Script threw an unreadable error"; }
    bridge("error", message);
  }
  for (const item of catalog) {
    const name = item.name;
    tools[name] = (args) => new Promise((resolve, reject) => {
      if (finished) { reject(new ErrorCtor("Script has finished")); return; }
      let json;
      try { json = args === undefined ? undefined : stringify(args); }
      catch (error) { reject(error); return; }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      bridge("call", id, name, json);
    });
    Object.freeze(item);
  }
  Object.freeze(tools);
  Object.freeze(catalog);
  Object.defineProperty(globalThis, "tools", { value: tools });
  Object.defineProperty(globalThis, "ALL_TOOLS", { value: catalog });
  Object.defineProperty(globalThis, "text", { value(value) {
    if (finished) return;
    const rendered = typeof value === "string" ? value : stringify(value);
    bridge("output", rendered === undefined ? String(value) : rendered);
  }});
  return {
    run(fn) {
      try {
        then.call(fn(), () => {
          if (finished) return;
          finished = true;
          bridge("done");
        }, fail);
      } catch (error) { fail(error); }
    },
    settle(id, ok, payload) {
      if (finished) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (!ok) { entry.reject(new ErrorCtor(payload)); return; }
      try { entry.resolve(payload === undefined ? undefined : parse(payload)); }
      catch (error) { entry.reject(error); }
    },
    drain() {
      if (!finished && pending.size === 0) fail(new ErrorCtor("Script is waiting on a promise that cannot settle; no tool call is pending and timers are unavailable"));
    }
  };
})`;
