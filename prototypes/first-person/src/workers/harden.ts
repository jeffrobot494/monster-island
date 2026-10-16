// Shared worker host functions (also used by the arena).
export const hostNow = () => performance.now();
export const hostSetTimeout = (fn: () => void, ms: number) => self.setTimeout(fn, ms);
export const hostPost = (msg: unknown, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });
