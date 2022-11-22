import { createSignal, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import { createBeforeLeave } from "./lifecycle";
import type { LocationChange, LocationChangeSignal, RouterIntegration, RouterUtils } from "./types";

function bindEvent(target: EventTarget, type: string, handler: EventListener) {
  target.addEventListener(type, handler);
  return () => target.removeEventListener(type, handler);
}

function intercept<T>(
  [value, setValue]: [() => T, (v: T) => void],
  get?: (v: T) => T,
  set?: (v: T) => T
): [() => T, (v: T) => void] {
  return [get ? () => get(value()) : value, set ? (v: T) => setValue(set(v)) : setValue];
}

function querySelector<T extends Element>(selector: string) {
  // Guard against selector being an invalid CSS selector
  try {
    return document.querySelector<T>(selector);
  } catch (e) {
    return null;
  }
}

function scrollToHash(hash: string, fallbackTop?: boolean) {
  const el = querySelector(`#${hash}`);
  if (el) {
    el.scrollIntoView();
  } else if (fallbackTop) {
    window.scrollTo(0, 0);
  }
}

export function createMemoryHistory() {
  const entries = ["/"];
  let index = 0;
  const listeners: ((value: string) => void)[] = [];

  const go = (n: number) => {
    // https://github.com/remix-run/react-router/blob/682810ca929d0e3c64a76f8d6e465196b7a2ac58/packages/router/history.ts#L245
    index = Math.max(0, Math.min(index + n, entries.length - 1));

    const value = entries[index];
    listeners.forEach(listener => listener(value));
  };

  return {
    get: () => entries[index],
    set: ({ value, scroll, replace }: LocationChange) => {
      if (replace) {
        entries[index] = value;
      } else {
        entries.splice(index + 1, entries.length - index, value);
        index++;
      }
      if (scroll) {
        scrollToHash(value.split("#")[1] || "", true);
      }
    },
    back: () => {
      go(-1);
    },
    forward: () => {
      go(1);
    },
    go,
    listen: (listener: (value: string) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        listeners.splice(index, 1);
      };
    }
  };
}

export function createIntegration(
  get: () => string | LocationChange,
  set: (next: LocationChange) => void,
  init?: (notify: (value?: string | LocationChange) => void) => () => void,
  utils?: Partial<RouterUtils>
): RouterIntegration {
  let ignore = false;
  const wrap = (value: string | LocationChange) => (typeof value === "string" ? { value } : value);
  const signal = intercept<LocationChange>(
    createSignal(wrap(get()), { equals: (a, b) => a.value === b.value }),
    undefined,
    next => {
      !ignore && set(next);
      return next;
    }
  );

  init &&
    onCleanup(
      init((value = get()) => {
        ignore = true;
        signal[1](wrap(value));
        ignore = false;
      })
    );

  return {
    signal,
    utils
  };
}

export function normalizeIntegration(
  integration: RouterIntegration | LocationChangeSignal | undefined
): RouterIntegration {
  if (!integration) {
    return {
      signal: createSignal({ value: "" })
    };
  } else if (Array.isArray(integration)) {
    return {
      signal: integration
    };
  }
  return integration;
}

export function staticIntegration(obj: LocationChange): RouterIntegration {
  return {
    signal: [() => obj, next => Object.assign(obj, next)]
  };
}

let depth: number;
function saveCurrentDepth() {
  if (!window.history.state || window.history.state._depth == null) {
    window.history.replaceState({ ...window.history.state, _depth: window.history.length - 1 }, "");
  }
  depth = window.history.state._depth;
}
if (!isServer) {
  saveCurrentDepth();
}
const keepDepth = (state: any) => ({
  ...state,
  _depth: window.history.state && window.history.state._depth
});

function notifyIfNotBlocked(
  notify: (value?: string | LocationChange) => void,
  block: (delta: number | null) => boolean
) {
  let ignore = false;
  return () => {
    const prevDepth = depth;
    saveCurrentDepth();
    const delta = prevDepth == null ? null : depth - prevDepth;
    if (ignore) {
      ignore = false;
      return;
    }
    if (delta && block(delta)) {
      ignore = true;
      window.history.go(-delta);
    } else {
      notify();
    }
};
}

export function pathIntegration() {
  const getSource = () => ({
    value: window.location.pathname + window.location.search + window.location.hash,
    state: window.history.state
  });
  const beforeLeave = createBeforeLeave();
  return createIntegration(
    getSource,
    ({ value, replace, scroll, state }) => {
      if (replace) {
        window.history.replaceState(state, "", value);
      } else {
        window.history.pushState(state, "", value);
      }
      scrollToHash(window.location.hash.slice(1), scroll);
      saveCurrentDepth()
    },
    notify =>
      bindEvent(
        window,
        "popstate",
        notifyIfNotBlocked(notify, (delta) => {
          if (delta && delta < 0) {
            return !beforeLeave.confirm(delta);
          } else {
            const s = getSource();
            return !beforeLeave.confirm(s.value, { state: s.state });
          }
        })
      ),
    {
      go: delta => window.history.go(delta),
      beforeLeave
    }
  );
}

export function hashIntegration() {
  const getSource = () => window.location.hash.slice(1);
  const beforeLeave = createBeforeLeave();
  return createIntegration(
    getSource,
    ({ value, replace, scroll, state }) => {
      if (replace) {
        window.history.replaceState(keepDepth(state), "", "#" + value);
      } else {
        window.location.hash = value;
      }
      const hashIndex = value.indexOf("#");
      const hash = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
      scrollToHash(hash, scroll);
      saveCurrentDepth()
    },
    notify =>
      bindEvent(
        window,
        "hashchange",
        notifyIfNotBlocked(notify, (delta) => {
          if (delta && delta < 0) {
            return !beforeLeave.confirm(delta);
          } else {
            return !beforeLeave.confirm(getSource());
          }
        })
      ),
    {
      go: delta => window.history.go(delta),
      renderPath: path => `#${path}`,
      parsePath: str => {
        const to = str.replace(/^.*?#/, "");
        // Hash-only hrefs like `#foo` from plain anchors will come in as `/#foo` whereas a link to
        // `/foo` will be `/#/foo`. Check if the to starts with a `/` and if not append it as a hash
        // to the current path so we can handle these in-page anchors correctly.
        if (!to.startsWith("/")) {
          const [, path = "/"] = window.location.hash.split("#", 2);
          return `${path}#${to}`;
        }
        return to;
      },
      beforeLeave
    }
  );
}

export function memoryIntegration() {
  const memoryHistory = createMemoryHistory();
  return createIntegration(memoryHistory.get, memoryHistory.set, memoryHistory.listen, {
    go: memoryHistory.go
  });
}
