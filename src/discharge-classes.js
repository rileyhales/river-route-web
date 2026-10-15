/** The classes discharge is drawn in, for the map's stepper in the page and the live worker alike. */

/**
 * Write each river's class of ``discharge`` into ``classes``, and return it: ``perTenfold`` classes to each tenfold of
 * discharge above ``lowest``, from 0 at lowest and below up to ``top``, left unrounded so that a map can keep a margin
 * between classes.
 */
export function classifyDischarge(discharge, { lowest, perTenfold, top }, classes) {
  if (!(lowest > 0 && perTenfold > 0 && top > 0)) {
    throw new Error('discharge classes need a lowest discharge, classes a tenfold, and a top class above 0')
  }
  if (classes.length !== discharge.length) throw new Error(`${classes.length} classes cannot hold ${discharge.length}`)
  const tenfoldsOfLowest = Math.log10(lowest)
  for (let river = 0; river < discharge.length; river++) {
    const tenfolds = Math.log10(Math.max(discharge[river], lowest)) - tenfoldsOfLowest
    classes[river] = Math.min(tenfolds * perTenfold, top)
  }
  return classes
}
