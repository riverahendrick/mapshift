/** The running Mapshift version. A test keeps it equal to package.json. */
export const VERSION = '0.1.1'

/**
 * The map's on-disk format. Raising it makes every existing map rebuild itself in the background
 * the next time it is used, so an upgrade never leaves an old map answering.
 */
export const MAP_FORMAT = 3
