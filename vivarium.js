/**
 * MiniVivarium – A simplified vivarium-inspired simulation framework
 *
 * Connects multiple biological simulations (processes) that run at different
 * time scales through a shared hierarchical state store. Processes declare
 * their variable dependencies via port mappings, enabling modular composition
 * without tight coupling.
 *
 * Inspired by: vivarium-core (https://github.com/vivarium-collective/vivarium-core)
 *
 * Core classes:
 *   Store        – hierarchical key-value state store
 *   Process      – base class for a simulation step (override next())
 *   Compartment  – named container grouping related state and processes
 *   Vivarium     – composer that manages all processes and advances time
 */

'use strict';

/* ─── Internal utilities ─────────────────────────────────────────────────── */

function _deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _deepGet(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function _deepSet(obj, path, value) {
  const result = _deepCopy(obj);
  let cur = result;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof cur[key] !== 'object' || cur[key] === null) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
  return result;
}

/* ─── Store ──────────────────────────────────────────────────────────────── */

/**
 * Store – Hierarchical state storage
 *
 * The central repository shared by all processes.  Processes read and write
 * state through port declarations that map port names to paths inside the
 * store.
 *
 * @example
 * const store = new Store({
 *   cell:       { volume: 1.0 },
 *   metabolism: { atp: 2.0, glucose: 10.0 }
 * });
 *
 * store.get(['cell', 'volume']);        // → 1.0
 * store.set(['cell', 'volume'], 1.5);
 * store.getState();                     // full snapshot
 */
class Store {
  /**
   * @param {Object} [initialState={}] Initial state tree
   */
  constructor(initialState = {}) {
    this._state = _deepCopy(initialState);
  }

  /**
   * Read a value from the store.
   * @param {string[]} path  e.g. ['cell', 'volume']
   * @returns {*}
   */
  get(path) {
    if (!path || path.length === 0) return _deepCopy(this._state);
    return _deepGet(this._state, path);
  }

  /**
   * Write a value into the store.
   * @param {string[]} path
   * @param {*} value
   */
  set(path, value) {
    this._state = _deepSet(this._state, path, value);
  }

  /**
   * Return a deep copy of the full state tree.
   * @returns {Object}
   */
  getState() {
    return _deepCopy(this._state);
  }
}

/* ─── Process ────────────────────────────────────────────────────────────── */

/**
 * Process – Base class for all simulation processes
 *
 * A Process encapsulates one unit of computation.  It declares which store
 * variables it needs (ports), runs at its own time step, and produces
 * updated variable values each time it fires.
 *
 * Subclass Process and override `next()` to implement custom logic.
 *
 * @example
 * class CellGrowth extends Process {
 *   constructor() {
 *     super({
 *       name: 'CellGrowth',
 *       ports: {
 *         volume: ['cell', 'volume'],  // port name → store path
 *         atp:    ['metabolism', 'atp'],
 *       },
 *       timeStep: 1.0   // fires every 1.0 time unit
 *     });
 *   }
 *
 *   next(inputs, dt) {
 *     const growthRate = 0.01 * inputs.atp / (0.5 + inputs.atp);
 *     return { volume: inputs.volume * (1 + growthRate * dt) };
 *   }
 * }
 */
class Process {
  /**
   * @param {Object}   config
   * @param {string}   config.name              Display name for this process
   * @param {Object}   config.ports             Port map: { portName: storePath[] }
   * @param {number}   [config.timeStep=1.0]    How often (time units) this process fires
   */
  constructor({ name, ports = {}, timeStep = 1.0 }) {
    this.name = name;
    this.ports = ports;
    this.timeStep = timeStep;
    this._nextRunTime = 0;
  }

  /**
   * Compute the next state for this process.
   *
   * Override this method in your subclass.
   *
   * @param {Object} inputs  Current values of all declared ports { portName: value }
   * @param {number} dt      Elapsed time since the last run (equals timeStep normally)
   * @returns {Object}       Updated port values { portName: newValue }
   */
  next(inputs, dt) { // eslint-disable-line no-unused-vars
    return {};
  }

  /**
   * Optional: return initial state contributions for this process.
   * The returned object is merged into the store before the first step.
   * @returns {Object}
   */
  initialState() {
    return {};
  }
}

/* ─── Compartment ────────────────────────────────────────────────────────── */

/**
 * Compartment – A named container grouping related state and processes
 *
 * Compartments organise the simulation hierarchy.  Each compartment owns a
 * section of the state store (keyed by its name) and a set of processes.
 * Processes inside a compartment can still share variables across compartment
 * boundaries by pointing their port paths anywhere in the store.
 *
 * @example
 * const metabolismCompartment = new Compartment({
 *   name: 'metabolism',
 *   initialState: { glucose: 10.0, atp: 2.0, lactate: 0.0 },
 *   processes: [new MetabolismProcess()]
 * });
 */
class Compartment {
  /**
   * @param {Object}    config
   * @param {string}    config.name                     Compartment name (store namespace)
   * @param {Object}    [config.initialState={}]        Initial values under this namespace
   * @param {Process[]} [config.processes=[]]           Processes belonging to this compartment
   */
  constructor({ name, initialState = {}, processes = [] }) {
    this.name = name;
    this.initialState = initialState;
    this.processes = processes;
  }
}

/* ─── Vivarium ───────────────────────────────────────────────────────────── */

/**
 * Vivarium – Multi-timescale simulation composer
 *
 * The Vivarium wires together multiple processes (each with its own time
 * step) through a shared Store.  On every `step()` the process with the
 * earliest scheduled run time fires; the simulator advances to that instant
 * and records the current state.
 *
 * Key features:
 *   • Different time steps per process
 *   • Shared variables through port declarations
 *   • Compartments for logical organisation
 *   • History recording for tracked paths
 *
 * @example
 * const sim = new Vivarium({
 *   state: {
 *     cell:       { volume: 1.0 },
 *     metabolism: { atp: 2.0, glucose: 10.0 }
 *   },
 *   processes:   [new CellGrowth(), new Metabolism()],
 *   trackPaths:  [['cell', 'volume'], ['metabolism', 'atp']]
 * });
 *
 * const history = sim.run(60);  // simulate 60 time units
 * console.log(history.time);            // [0, 0.5, 1.0, ...]
 * console.log(history['cell.volume']);   // [1.0, 1.01, ...]
 */
class Vivarium {
  /**
   * @param {Object}         config
   * @param {Object}         [config.state={}]          Top-level initial state
   * @param {Compartment[]}  [config.compartments=[]]   Compartments to merge in
   * @param {Process[]}      [config.processes=[]]      Additional top-level processes
   * @param {string[][]}     [config.trackPaths=[]]     Store paths to record in history
   */
  constructor({ state = {}, compartments = [], processes = [], trackPaths = [] }) {
    // Merge compartment initial states into the shared store
    let mergedState = _deepCopy(state);
    const allProcesses = [...processes];

    for (const compartment of compartments) {
      mergedState[compartment.name] = Object.assign(
        {},
        compartment.initialState,
        mergedState[compartment.name] || {}
      );
      allProcesses.push(...compartment.processes);
    }

    this.store = new Store(mergedState);
    this.processes = allProcesses;
    this._time = 0;
    this._trackPaths = trackPaths;

    // Initialise history with time=0 snapshot
    this._history = { time: [0] };
    for (const path of trackPaths) {
      const key = path.join('.');
      this._history[key] = [this.store.get(path)];
    }

    // All processes start at time 0
    for (const p of this.processes) {
      p._nextRunTime = 0;
    }
  }

  /** @returns {number} Current simulation time */
  get time() { return this._time; }

  /**
   * Advance the simulation by exactly one event – the next scheduled process.
   */
  step() {
    const nextTime = this._nextEventTime();

    for (const process of this.processes) {
      // Use a small epsilon to handle floating-point accumulation
      if (process._nextRunTime <= nextTime + 1e-10) {
        const inputs = this._gatherInputs(process);
        const outputs = process.next(inputs, process.timeStep);
        this._applyOutputs(process, outputs);
        process._nextRunTime += process.timeStep;
      }
    }

    this._time = nextTime;
    this._recordHistory();
  }

  /**
   * Run the simulation for `totalTime` time units.
   * @param {number} totalTime   Duration to simulate
   * @param {number} [maxSteps=100000]  Safety cap on iterations
   * @returns {Object}  History object: { time: [...], 'store.path': [...], ... }
   */
  run(totalTime, maxSteps = 100000) {
    const endTime = this._time + totalTime;
    let steps = 0;
    while (this._time < endTime - 1e-10 && steps < maxSteps) {
      this.step();
      steps++;
    }
    return this.getHistory();
  }

  /**
   * Return a deep copy of the recorded history.
   * @returns {Object}
   */
  getHistory() {
    return _deepCopy(this._history);
  }

  /**
   * Return the current full state of the store.
   * @returns {Object}
   */
  getState() {
    return this.store.getState();
  }

  /* ── Private helpers ──────────────────────────────────────────────────── */

  _nextEventTime() {
    if (this.processes.length === 0) return this._time + 1;
    return Math.min(...this.processes.map(p => p._nextRunTime));
  }

  _gatherInputs(process) {
    const inputs = {};
    for (const [portName, storePath] of Object.entries(process.ports)) {
      inputs[portName] = this.store.get(storePath);
    }
    return inputs;
  }

  _applyOutputs(process, outputs) {
    if (!outputs) return;
    for (const [portName, newValue] of Object.entries(outputs)) {
      if (newValue === undefined || newValue === null) continue;
      const storePath = process.ports[portName];
      if (!storePath) continue;
      this.store.set(storePath, newValue);
    }
  }

  _recordHistory() {
    this._history.time.push(this._time);
    for (const path of this._trackPaths) {
      const key = path.join('.');
      const val = this.store.get(path);
      this._history[key].push(val !== undefined ? val : null);
    }
  }
}

/* ─── Exports ────────────────────────────────────────────────────────────── */

// Browser: expose as window.MiniVivarium
// Node.js / test runner: expose via module.exports
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Store, Process, Compartment, Vivarium };
} else if (typeof window !== 'undefined') {
  window.MiniVivarium = { Store, Process, Compartment, Vivarium };
}
