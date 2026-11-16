import fc from 'fast-check';

// Requirement 1.8: at least 1,000 generated cases per property. Do not lower.
fc.configureGlobal({ numRuns: 1000 });
