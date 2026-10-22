import { isBuiltin } from "node:module";

import type { ExternalRule, ExternalOption } from "../../types";
export type { ExternalRule, ExternalOption } from "../../types";

function matches(rule: ExternalRule, id: string, subpaths: boolean): boolean {
  if (typeof rule === "string") return id === rule || (subpaths && id.startsWith(rule + "/"));
  const previous = rule.lastIndex;
  rule.lastIndex = 0;
  const result = rule.test(id);
  rule.lastIndex = previous;
  return result;
}

export function nodeExternal(existing?: ExternalOption, additional?: ExternalOption): (id: string, importer: string | undefined, isResolved: boolean) => boolean {
  return function (this: unknown, id, importer, isResolved) {
    if (id.startsWith("node:") || isBuiltin(id)) return true;
    const check = (option: ExternalOption | undefined, subpaths: boolean): boolean => {
      if (typeof option === "function") return !!option.call(this, id, importer, isResolved);
      return (Array.isArray(option) ? option : option === undefined ? [] : [option]).some(rule => matches(rule, id, subpaths));
    };
    return check(additional, true) || check(existing, false);
  };
}

