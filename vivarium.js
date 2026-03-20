/**
 * vivarium.js
 * A simplified multi-simulation framework inspired by Vivarium.
 *
 * Core concepts:
 *   Store       – holds named state variables and their history
 *   Process     – runs a simulation step at its own time step, reads/writes
 *                 stores through declared ports
 *   Compartment – groups stores and processes; handles stepping
 *   Simulation  – top-level orchestrator for one or more compartments
 *
 * Extended API (hierarchical path-based store):
 *   HierarchicalStore – deep key-path state store
 *   SimProcess        – abstract base class for processes (override next())
 *   Vivarium          – event-driven composer using HierarchicalStore
 */

// ---------------------------------------------------------------------------
// Store  (flat key → value, used by Simulation)
// ---------------------------------------------------------------------------
class Store {
  /**
   * @param {Object.<string, number>} initialValues  variable name → initial value
   */
  constructor(initialValues) {
    this.variables = Object.assign({}, initialValues);
    // history[varName] = [value at t0, value at t1, …]
    this.history = {};
    for (const [k, v] of Object.entries(initialValues)) {
      this.history[k] = [v];
    }
  }

  /** Read a variable by name */
  get(key) {
    return this.variables[key];
  }

  /** Overwrite a variable */
  set(key, value) {
    this.variables[key] = value;
  }

  /** Add deltas to existing values (clamp at 0 by default) */
  update(deltas, clampAtZero = true) {
    for (const [k, delta] of Object.entries(deltas)) {
      if (k in this.variables) {
        const next = this.variables[k] + delta;
        this.variables[k] = clampAtZero ? Math.max(0, next) : next;
      }
    }
  }

  /** Save current values to history (called once per global dt) */
  snapshot() {
    for (const k of Object.keys(this.variables)) {
      this.history[k].push(this.variables[k]);
    }
  }
}

// ---------------------------------------------------------------------------
// Process  (used by Simulation – concrete, takes an updateFn)
// ---------------------------------------------------------------------------
class Process {
  /**
   * @param {string}   name       Human-readable label
   * @param {Object.<string,string>} ports  portName → storeName mapping
   * @param {number}   timestep   How often (in simulation time) this process fires
   * @param {function} updateFn   (portState, dt) → {portName: {varName: delta, …}, …}
   */
  constructor(name, ports, timestep, updateFn) {
    this.name = name;
    this.ports = ports;
    this.timestep = timestep;
    this.updateFn = updateFn;
    this._accumulated = 0;
  }

  /**
   * Advance by globalDt. Fires updateFn when accumulated time ≥ own timestep.
   * @param {number}                   globalDt
   * @param {Object.<string, Store>}   stores    all stores in the compartment
   */
  step(globalDt, stores) {
    this._accumulated += globalDt;
    if (this._accumulated < this.timestep) return;

    // Build port-keyed state snapshot for the update function
    const portState = {};
    for (const [portName, storeName] of Object.entries(this.ports)) {
      if (stores[storeName]) {
        portState[portName] = Object.assign({}, stores[storeName].variables);
      }
    }

    const updates = this.updateFn(portState, this.timestep);

    // Apply updates back to the appropriate stores
    if (updates) {
      for (const [portName, deltas] of Object.entries(updates)) {
        const storeName = this.ports[portName];
        if (storeName && stores[storeName] && deltas) {
          stores[storeName].update(deltas);
        }
      }
    }

    this._accumulated -= this.timestep;
  }

  /** Reset accumulated time (useful when restarting a simulation) */
  reset() {
    this._accumulated = 0;
  }
}

// ---------------------------------------------------------------------------
// Compartment  (used by Simulation)
// ---------------------------------------------------------------------------
class Compartment {
  /**
   * @param {string}                   name
   * @param {Object.<string, Store>}   stores     storeName → Store
   * @param {Process[]}                processes
   */
  constructor(name, stores, processes) {
    this.name = name;
    this.stores = stores;
    this.processes = processes;
  }

  /** Advance all processes then snapshot all stores */
  step(globalDt) {
    for (const process of this.processes) {
      process.step(globalDt, this.stores);
    }
    for (const store of Object.values(this.stores)) {
      store.snapshot();
    }
  }

  /** Reset processes and clear store history back to current values */
  reset() {
    for (const process of this.processes) {
      process.reset();
    }
  }
}

// ---------------------------------------------------------------------------
// Simulation  (top-level orchestrator using global dt + compartments)
// ---------------------------------------------------------------------------
class Simulation {
  /**
   * @param {Object.<string, Compartment>} compartments
   * @param {number}                        dt   Global (minimum) time step
   */
  constructor(compartments, dt = 0.1) {
    this.compartments = compartments;
    this.dt = dt;
    this.time = 0;
    this.timeHistory = [0];
  }

  /** Run a single global time step across every compartment */
  step() {
    for (const compartment of Object.values(this.compartments)) {
      compartment.step(this.dt);
    }
    this.time = parseFloat((this.time + this.dt).toFixed(10));
    this.timeHistory.push(this.time);
  }

  /** Run for `duration` simulation time units */
  run(duration) {
    const steps = Math.round(duration / this.dt);
    for (let i = 0; i < steps; i++) {
      this.step();
    }
  }

  /** Reset simulation back to t=0 */
  reset() {
    this.time = 0;
    this.timeHistory = [0];
    for (const compartment of Object.values(this.compartments)) {
      compartment.reset();
    }
  }
}

// ---------------------------------------------------------------------------
// Built-in example simulations
// ---------------------------------------------------------------------------

/**
 * buildBacterialGrowthCompartment
 * Models a bacterial population consuming nutrients with logistic growth.
 * Stores : { cell: { population, nutrients } }
 * Process: growthProcess (timestep = 1.0)
 */
function buildBacterialGrowthCompartment(opts = {}) {
  const {
    initialPopulation = 10,
    initialNutrients = 1000,
    growthRate = 0.3,
    yieldCoeff = 0.5,
    carryingCapacity = 500,
    timestep = 1.0,
  } = opts;

  const cellStore = new Store({
    population: initialPopulation,
    nutrients: initialNutrients,
  });

  const growthProcess = new Process(
    'Bacterial Growth',
    { cell: 'cell' },
    timestep,
    (state, dt) => {
      const { population, nutrients } = state.cell;
      const nutrientFraction = Math.max(0, nutrients / (nutrients + 100));
      const logisticFactor = Math.max(0, 1 - population / carryingCapacity);
      const growth = growthRate * population * nutrientFraction * logisticFactor * dt;
      return {
        cell: {
          population: growth,
          nutrients: -growth / yieldCoeff,
        },
      };
    }
  );

  return new Compartment('Bacterial Growth', { cell: cellStore }, [growthProcess]);
}

/**
 * buildGeneExpressionCompartment
 * Models mRNA transcription and protein translation/degradation.
 * Stores : { gene: { mRNA, protein } }
 * Process: transcription (timestep = 0.5), translation (timestep = 1.0)
 */
function buildGeneExpressionCompartment(opts = {}) {
  const {
    mRNAInit = 0,
    proteinInit = 0,
    transcriptionRate = 5,
    mRNADegradation = 0.3,
    translationRate = 2,
    proteinDegradation = 0.05,
    timestepFast = 0.5,
    timestepSlow = 1.0,
  } = opts;

  const geneStore = new Store({ mRNA: mRNAInit, protein: proteinInit });

  const transcriptionProcess = new Process(
    'Transcription',
    { gene: 'gene' },
    timestepFast,
    (state, dt) => {
      const { mRNA } = state.gene;
      const dmRNA = (transcriptionRate - mRNADegradation * mRNA) * dt;
      return { gene: { mRNA: dmRNA } };
    }
  );

  const translationProcess = new Process(
    'Translation',
    { gene: 'gene' },
    timestepSlow,
    (state, dt) => {
      const { mRNA, protein } = state.gene;
      const dProtein = (translationRate * mRNA - proteinDegradation * protein) * dt;
      return { gene: { protein: dProtein } };
    }
  );

  return new Compartment(
    'Gene Expression',
    { gene: geneStore },
    [transcriptionProcess, translationProcess]
  );
}

/**
 * buildMetabolicCompartment
 * Simple ATP production / consumption model.
 * Stores : { metabolites: { ATP, ADP, glucose } }
 * Process: glycolysis (timestep = 0.25), consumption (timestep = 0.5)
 */
function buildMetabolicCompartment(opts = {}) {
  const {
    initialATP = 10,
    initialADP = 5,
    initialGlucose = 200,
    glycolysisRate = 0.8,
    consumptionRate = 0.3,
    timestepFast = 0.25,
    timestepSlow = 0.5,
  } = opts;

  const metStore = new Store({
    ATP: initialATP,
    ADP: initialADP,
    glucose: initialGlucose,
  });

  const glycolysisProcess = new Process(
    'Glycolysis',
    { metabolites: 'metabolites' },
    timestepFast,
    (state, dt) => {
      const { glucose, ADP } = state.metabolites;
      const flux = glycolysisRate * Math.min(glucose, ADP) * dt;
      return {
        metabolites: { ATP: flux * 2, ADP: -flux * 2, glucose: -flux },
      };
    }
  );

  const consumptionProcess = new Process(
    'ATP Consumption',
    { metabolites: 'metabolites' },
    timestepSlow,
    (state, dt) => {
      const { ATP } = state.metabolites;
      const consumed = consumptionRate * ATP * dt;
      return {
        metabolites: { ATP: -consumed, ADP: consumed },
      };
    }
  );

  return new Compartment(
    'Metabolism',
    { metabolites: metStore },
    [glycolysisProcess, consumptionProcess]
  );
}

// ===========================================================================
// Extended API  –  hierarchical path-based store + event-driven composer
// ===========================================================================

// ── Internal utilities ──────────────────────────────────────────────────────

function _hDeepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

function _hDeepGet(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function _hDeepSet(obj, path, value) {
  const result = _hDeepCopy(obj);
  let cur = result;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
  return result;
}

/**
 * HierarchicalStore – nested key-path state store used by Vivarium.
 *
 * @example
 * const store = new HierarchicalStore({ cell: { volume: 1.0 } });
 * store.get(['cell', 'volume']);     // → 1.0
 * store.set(['cell', 'volume'], 2);
 */
class HierarchicalStore {
  constructor(initialState = {}) {
    this._state = _hDeepCopy(initialState);
  }

  /** Read a value at the given path array, e.g. ['cell', 'volume'] */
  get(path) {
    if (!path || path.length === 0) return _hDeepCopy(this._state);
    return _hDeepGet(this._state, path);
  }

  /** Write a value at the given path */
  set(path, value) {
    this._state = _hDeepSet(this._state, path, value);
  }

  /** Return a deep copy of the full state tree */
  getState() { return _hDeepCopy(this._state); }
}

/**
 * SimProcess – abstract base class for event-driven processes used by Vivarium.
 *
 * Subclass and override `next(inputs, dt)` to define your process logic.
 *
 * @example
 * class CellGrowth extends SimProcess {
 *   constructor() {
 *     super({
 *       name: 'CellGrowth',
 *       ports: { volume: ['cell', 'volume'], atp: ['metabolism', 'atp'] },
 *       timeStep: 1.0
 *     });
 *   }
 *   next(inputs, dt) {
 *     const mu = 0.015 * inputs.atp / (1 + inputs.atp);
 *     return { volume: inputs.volume * (1 + mu * dt) };
 *   }
 * }
 */
class SimProcess {
  /**
   * @param {Object} config
   * @param {string} config.name       Display name
   * @param {Object} config.ports      { portName: storePath[] } – port → path in HierarchicalStore
   * @param {number} [config.timeStep=1.0]  How often (time units) this process fires
   */
  constructor({ name, ports = {}, timeStep = 1.0 }) {
    this.name = name;
    this.ports = ports;
    this.timeStep = timeStep;
    this._nextRunTime = 0;
  }

  /**
   * Compute the next state.  Override in subclasses.
   * @param {Object} inputs   Current port values { portName: value }
   * @param {number} dt       Elapsed time (equals timeStep on normal runs)
   * @returns {Object}        Updated port values { portName: newValue }
   */
  next(inputs, dt) { return {}; } // eslint-disable-line no-unused-vars

  /** Optional: return initial state contributions merged into the Vivarium store */
  initialState() { return {}; }
}

/**
 * Vivarium – event-driven multi-timescale simulation composer.
 *
 * Connects multiple SimProcess instances (possibly in different Compartments)
 * each running at its own time step through a shared HierarchicalStore.
 *
 * @example
 * const sim = new Vivarium({
 *   state: { cell: { volume: 1.0 }, metabolism: { atp: 2.0, glucose: 10.0 } },
 *   processes: [new CellGrowth(), new Metabolism()],
 *   trackPaths: [['cell', 'volume'], ['metabolism', 'atp']]
 * });
 * const history = sim.run(60);
 * // history = { time: [...], 'cell.volume': [...], 'metabolism.atp': [...] }
 */
class Vivarium {
  /**
   * @param {Object}        config
   * @param {Object}        [config.state={}]          Top-level initial state
   * @param {Object[]}      [config.compartments=[]]   Compartment descriptors { name, initialState, processes }
   * @param {SimProcess[]}  [config.processes=[]]      Additional top-level processes
   * @param {string[][]}    [config.trackPaths=[]]     Store paths to record in history
   */
  constructor({ state = {}, compartments = [], processes = [], trackPaths = [] }) {
    let mergedState = _hDeepCopy(state);
    const allProcesses = [...processes];

    for (const comp of compartments) {
      mergedState[comp.name] = Object.assign(
        {},
        comp.initialState || {},
        mergedState[comp.name] || {}
      );
      if (comp.processes) allProcesses.push(...comp.processes);
    }

    this.store = new HierarchicalStore(mergedState);
    this.processes = allProcesses;
    this._time = 0;
    this._trackPaths = trackPaths;

    this._history = { time: [0] };
    for (const path of trackPaths) {
      this._history[path.join('.')] = [this.store.get(path)];
    }

    for (const p of this.processes) p._nextRunTime = 0;
  }

  /** Current simulation time */
  get time() { return this._time; }

  /** Advance by one event (smallest next scheduled process time) */
  step() {
    const nextTime = this.processes.length
      ? Math.min(...this.processes.map(p => p._nextRunTime))
      : this._time + 1;

    for (const proc of this.processes) {
      if (proc._nextRunTime <= nextTime + 1e-10) {
        const inputs = {};
        for (const [pn, sp] of Object.entries(proc.ports)) {
          inputs[pn] = this.store.get(sp);
        }
        const outputs = proc.next(inputs, proc.timeStep);
        if (outputs) {
          for (const [pn, val] of Object.entries(outputs)) {
            if (val !== undefined && val !== null && proc.ports[pn]) {
              this.store.set(proc.ports[pn], val);
            }
          }
        }
        proc._nextRunTime += proc.timeStep;
      }
    }

    this._time = nextTime;
    this._history.time.push(this._time);
    for (const path of this._trackPaths) {
      const key = path.join('.');
      const val = this.store.get(path);
      this._history[key].push(val !== undefined ? val : null);
    }
  }

  /**
   * Run for `totalTime` time units.
   * @param {number} totalTime
   * @param {number} [maxSteps=100000]
   * @returns {Object}  { time: [...], 'path.key': [...], ... }
   */
  run(totalTime, maxSteps = 100000) {
    const end = this._time + totalTime;
    let n = 0;
    while (this._time < end - 1e-10 && n < maxSteps) { this.step(); n++; }
    return this.getHistory();
  }

  /** Return a copy of recorded history */
  getHistory() { return _hDeepCopy(this._history); }

  /** Return current store state */
  getState() { return this.store.getState(); }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined') {
  module.exports = {
    // Simulation-based API
    Store,
    Process,
    Compartment,
    Simulation,
    buildBacterialGrowthCompartment,
    buildGeneExpressionCompartment,
    buildMetabolicCompartment,
    // Vivarium event-driven API
    HierarchicalStore,
    SimProcess,
    Vivarium,
  };
} else if (typeof window !== 'undefined') {
  window.VivFramework = {
    // Simulation-based API
    Store,
    Process,
    Compartment,
    Simulation,
    buildBacterialGrowthCompartment,
    buildGeneExpressionCompartment,
    buildMetabolicCompartment,
    // Vivarium event-driven API
    HierarchicalStore,
    SimProcess,
    Vivarium,
  };
}
