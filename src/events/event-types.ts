/** Call to stop listening / release a subscription. */
export type Unsubscribe = () => void;

/** Function that will be called when an event is emitted. Receives a single payload value. Use `void` for "no data" events. */
export type Listener<TPayload> = (payload: TPayload) => void;

/**
 * Describes the events an emitter can produce: a map of event name -> payload type.
 * Use `void` as the payload type for events that carry no data.
 *
 * @example
 * type CollectionEvents = {
 *   changed: { id: string; };
 *   cleared: void;
 * };
 */
export type EventMap = Record<string, unknown>;
