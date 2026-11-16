import fc from 'fast-check';

// Requirement 1.8: at least 1,000 generated cases per property. Do not lower.
// On failure fast-check prints the seed, the path, and the shrunk counterexample;
// record failing seeds as regression `examples` in the property (architecture.md).
fc.configureGlobal({ numRuns: 1000 });
