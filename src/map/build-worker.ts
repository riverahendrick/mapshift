import { workerData } from 'node:worker_threads'
import { buildNow, closeMaps } from './indexer.ts'

/** Runs in a background thread: builds one repository's map, then exits. */
const { root } = workerData as { root: string }
try {
  await buildNow(root)
} catch {
  // the next query tries again; a background build never takes the server down
} finally {
  closeMaps()
}
