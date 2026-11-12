import { EventEmitter } from 'node:events';

/** In-process pub/sub for seat-map changes. Swap for Redis pub/sub when running several app instances. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);
export const seatChanged = tripId => bus.emit(`seats:${tripId}`);
