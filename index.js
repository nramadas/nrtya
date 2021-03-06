/**
 * @module nrtya
 */

/**
 * @typedef  {object} Thread
 * @property {function} run - A method that runs a function in a WebWorker
 * @property {boolean}  running - Whether the associated WebWorker is busy
 * @property {Worker}   worker - The WebWorker itself
 */

/**
 * @typedef  {object} Task
 * @property {function} fn - The function to execute in this task
 * @property {array}    args - The arguments that should be passed to the
 *   function during execution
 * @property {function} returnResult - The callback to fire when results are
 *   available.
 */

/**
 * Converts a string into a blob.
 * @param   {string} inputString - The string to convert into a `Blob`.
 * @returns {Blob}
 */
const makeBlob = inputString => {
  if (typeof Blob !== 'undefined') {
    return new Blob([inputString], { type: 'text/javascript' });
  }

  const builder = window.BlobBuilder ||
    window.WebKitBlobBuilder ||
    window.MozBlobBuilder;

  const blob = new builder();
  blob.append(inputString);
  return blob.getBlob();
 };

/**
 * An object url that is used to spawn a WebWorker
 * @const {string}
 */
const WORKER_URL = (() => {
  // base script that will run in each web worker;
  const workerScript = `
    onmessage = function(event) {
      var args = event.data.args;
      var id = event.data.id;
      var fn = eval("(" + event.data.fn + ")");
      var result = fn.apply(null, args);
      postMessage({ id: id, result: result });
    }`;

  // conver the script into a blob
  const blob = makeBlob(workerScript);

  // grab the appropriate api to convert a blob into an object url.
  const urlMaker = window.URL || window.webkitURL;

  // make the url
  return urlMaker.createObjectURL(blob);
})();

/**
 * Creates a new unique id. Id's are only unique relative to WebWorkers spawned
 * by this script.
 * @function
 * @returns {number} A unique id
 */
const makeId = (() => {
  let id = 0;
  return () => id++;
})();

/**
 * Creates a `Thread` object that contains a WebWorker, a flag to indicate the
 * thread's availability, and a helper method to force the worker contained in
 * the `Thread` to execute code.
 * @function
 * @returns {Thread} A worker
 */
const makeWorker = () => {
  // set up a new worker
 const worker = new Worker(WORKER_URL);

 return {
   run(fn, args) {
     return new Promise(resultResult => {
       // flag the worker as running so that any future work is not assigned
       // to this worker
       this.running = true;

       // grab a unique id for the task. this is largely an assurance that this
       // method will resolve with the correct data.
       const id = makeId();

       // listen to the worker and wait for a result
       this.worker.addEventListener('message', event => {
         // when the worker communicates back, first verify that the id's match.
         // if they do, we're going to resolve the promise with the result.
         if (event.data.id === id) resultResult(event.data.result);

         if (FUNCTION_QUEUE.length) {
           // grab the first `Task` from the queue
           const newTask = FUNCTION_QUEUE[0];
           FUNCTION_QUEUE = FUNCTION_QUEUE.slice(1);

           // run the `Task` on this worker
           this.run(newTask.fn, newTask.args).then(newTask.returnResult);
         } else {
           // nothing left to do. mark as no longer running
           this.running = false;
         }
       });

       // sent the task to the worker
       this.worker.postMessage({ id, args, fn: fn.toString() });
     });
   },
   running: false,
   worker: worker,
 };
};

/**
 * Determines how many workers we should create. Uses the `hardwareConcurrency`
 * api. If the browser doesn't have that, just spin up a single worker.
 * @returns {number} Number of workers to be created.
 */
const getNumCores = () => {
 if (window.navigator.hardwareConcurrency) {
   return window.navigator.hardwareConcurrency - 1;
 }

 return 1;
}

/**
 * How many workers the browser can efficiently support
 * @const {number}
 */
const NUM_WORKERS = getNumCores();

/**
 * A list of `Threads` to run tasks on.
 * @const {array<Thread>}
 */
const THREADS = Array.from(Array(NUM_WORKERS)).map(makeWorker);

/**
 * A list of queued up `Task`s.
 * @const {array<Task>}
 */
let FUNCTION_QUEUE = [];

/**
 * Decorates a function. The new decorated function will execute asynchronously
 * on a separate thread using a WebWorker. Calling the decorated function will
 * return a `Promise` that will resolve with the results.
 *
 * This function can _only_ decorate pure functions. Functions that rely on
 * closures, side-effects, and other non-pure phenominon **will not work**.
 * @function
 * @param   {function} fn - The function to wrap
 * @returns {function} The decorated function
 */
module.exports = function nrtya(fn) {
  return (...args) => new Promise(returnResult => {
    // check to see if we have any free `Thread`s. If there is, that `Thread` is
    // used immediately to execute the function.
    const shouldQueue = THREADS.every(thread => {
      if (!thread.running) {
        // there is a free thread
        thread.run(fn, args).then(result => returnResult(result));
        return false;
      };

      return true;
    });

    // there were no free threads, so a 'Task' is created and queued.
    if (shouldQueue) {
      // add this `Task` to the queue.
      FUNCTION_QUEUE = FUNCTION_QUEUE.concat({ fn, args, returnResult });
    }
  });
}
