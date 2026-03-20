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
 */

// ---------------------------------------------------------------------------
// Store
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
// Process
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
// Compartment
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
// Simulation
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

// Export for use by the page (globals in browser context)
if (typeof module !== 'undefined') {
  module.exports = {
    Store,
    Process,
    Compartment,
    Simulation,
    buildBacterialGrowthCompartment,
    buildGeneExpressionCompartment,
    buildMetabolicCompartment,
  };
}
