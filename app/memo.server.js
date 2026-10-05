// Share one answer between everyone who asks at the same moment.
//
// When a cached answer expires, every request arriving in that instant used to ask the database for itself
// (a "thundering herd"), which got slower exactly when the server was busiest. memo() makes them all wait for
// ONE fetch, keeps its answer for `ms` milliseconds, and never keeps a failure.
const store = new Map();

export function memo(key, ms, fn) {
  const hit = store.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ms)) return hit.promise;
  const entry = { at: Date.now(), pending: true, promise: null };
  entry.promise = Promise.resolve().then(fn);
  entry.promise.then(
    () => {
      entry.pending = false;
      entry.at = Date.now(); // freshness counts from when the answer arrived
    },
    () => {
      if (store.get(key) === entry) store.delete(key); // a failed fetch is never shared with the next request
    },
  );
  if (store.size > 1000) store.clear();
  store.set(key, entry);
  return entry.promise;
}

export function memoReset() {
  store.clear();
}
