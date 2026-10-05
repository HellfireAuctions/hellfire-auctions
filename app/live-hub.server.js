// The live hub: who is watching which auction, and a way to tell all of them something changed.
// One server process serves every shopper, so this lives in memory. It is stored on globalThis so every part of the
// server (the bid route, the stream route, the background worker) always shares the very same hub.
const KEY = "__hellfireLiveHub";

function hub() {
  return (globalThis[KEY] ||= { rooms: new Map(), total: 0, seq: 0 });
}

export function subscribe(auctionId, send) {
  const h = hub();
  let room = h.rooms.get(auctionId);
  if (!room) h.rooms.set(auctionId, (room = new Set()));
  room.add(send);
  h.total += 1;
  let active = true;
  return function unsubscribe() {
    if (!active) return;
    active = false;
    room.delete(send);
    if (room.size === 0 && h.rooms.get(auctionId) === room) h.rooms.delete(auctionId);
    h.total -= 1;
  };
}

// Tells everyone watching this auction that something changed. Returns how many were told.
export function publish(auctionId, kind = "update") {
  const h = hub();
  const room = h.rooms.get(auctionId);
  if (!room || room.size === 0) return 0;
  h.seq += 1;
  const payload = { id: auctionId, seq: h.seq, at: Date.now() };
  let told = 0;
  for (const send of [...room]) {
    try {
      send(kind, payload);
      told += 1;
    } catch {
      /* a dead connection cleans itself up */
    }
  }
  return told;
}

export function connectionCount() {
  return hub().total;
}

export function roomCount() {
  return hub().rooms.size;
}

export function resetHub() {
  delete globalThis[KEY];
}
