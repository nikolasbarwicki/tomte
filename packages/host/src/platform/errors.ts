/** A user-correctable input problem, found by a feature's own domain rules. */
export class InvalidInput extends Error {}

/** The thing a request names does not exist, such as an unknown bot id. */
export class NotFound extends Error {}
