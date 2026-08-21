// Patched from upstream: element types come from the local structural declaration, and
// the debounce helper is typed so the file compiles under strict TypeScript. Logic is
// unchanged.
import type { ExcalidrawElement } from "./types";
import * as Y from "yjs"


export const moveArrayItem = <T>(arr: T[], from: number, to: number, inPlace = true) => {
  if (!inPlace) {
    arr = [...arr]
  }
  arr.splice(to, 0, arr.splice(from, 1)[0] as T);
  return arr
};

// https://stackoverflow.com/a/75988895
export const debounce = <A extends unknown[]>(callback: (...args: A) => void, wait: number) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timeoutId != null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      callback(...args);
    }, wait);
  };
}

export const areElementsSame = (els1: readonly {id: string, version: number}[], els2: readonly {id: string, version: number}[]) => {
  if (els1.length !== els2.length) {
    return false
  }

  for (let i=0; i<els1.length; i++) {
    if (els1[i]!.id !== els2[i]!.id || els1[i]!.version !== els2[i]!.version ) {
      return false
    }
  }

  return true
}

export const yjsToExcalidraw = (yArray: Y.Array<Y.Map<any>>): ExcalidrawElement[] => {
  let x = yArray.toArray()
    .sort((a, b) => {
      const key1 = a.get("pos") as string;
      const key2 = b.get("pos") as string;
      return key1 > key2 ? 1 : (key1 < key2 ? -1 : 0)
    })
    .map((x) => x.get("el") as ExcalidrawElement)
  return x
}
