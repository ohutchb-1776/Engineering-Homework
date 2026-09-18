/**
 * The modelling choices this app makes where the code is silent.
 *
 * These are not zoning. They are the handful of numbers you need to turn a
 * height limit into a story count and a floor area into a unit count. They
 * live here, in one place, so they can be listed on screen and argued with.
 */
export interface EngineAssumptions {
  /** Floor-to-floor height for a typical wood-frame apartment building. */
  floorToFloorFt: number;
  /** Roof assembly and parapet above the top floor, taken off the height budget. */
  roofAssemblyFt: number;
  /** Share of gross floor area that ends up as leasable apartment. */
  grossToNetRatio: number;
  /** Average net area of one apartment. */
  averageUnitNetSf: number;
  /** Lot area consumed by one surface parking space including aisle. */
  surfaceParkingSfPerSpace: number;
}

export const DEFAULT_ASSUMPTIONS: EngineAssumptions = {
  floorToFloorFt: 10,
  roofAssemblyFt: 3,
  grossToNetRatio: 0.82,
  averageUnitNetSf: 750,
  surfaceParkingSfPerSpace: 325,
};

export function describeAssumptions(a: EngineAssumptions) {
  return [
    {
      id: "floor-to-floor",
      label: "Floor-to-floor height",
      value: `${a.floorToFloorFt} ft`,
      why: "Typical for wood-frame multifamily construction. Concrete or ground-floor retail pushes this higher and costs a storey.",
    },
    {
      id: "roof-assembly",
      label: "Roof and parapet",
      value: `${a.roofAssemblyFt} ft`,
      why: "Taken off the height budget before counting storeys, since the limit is measured to the roof, not to the top ceiling.",
    },
    {
      id: "efficiency",
      label: "Gross-to-net efficiency",
      value: `${Math.round(a.grossToNetRatio * 100)}%`,
      why: "Corridors, stairs, lifts, walls and plant take roughly a fifth of gross floor area in a mid-size apartment building.",
    },
    {
      id: "unit-size",
      label: "Average apartment size",
      value: `${a.averageUnitNetSf} sf net`,
      why: "A mix weighted toward one-bedrooms. A studio-heavy building yields more units, a family-sized mix fewer.",
    },
    {
      id: "rectangular-massing",
      label: "Building shape",
      value: "Fills the setback envelope, uniform on every floor",
      why: "Real buildings step back, notch for light and air, and lose area to fire separation. This is an upper bound, not a design.",
    },
  ];
}
