import { describe, expect, it } from 'vitest';
import { incidentCanAddRegression, incidentCanCorrect, incidentCanResolve, incidentCanSetRootCause } from './App';

describe('Phase 05 incident controls', () => {
  it('follows the frozen incident lifecycle for correction and root cause', () => {
    expect(incidentCanCorrect('OPEN')).toBe(true);
    expect(incidentCanCorrect('CORRECTION_DRAFTED')).toBe(true);
    expect(incidentCanCorrect('CORRECTED')).toBe(false);
    expect(incidentCanSetRootCause('CORRECTED')).toBe(true);
    expect(incidentCanSetRootCause('OPEN')).toBe(false);
    expect(incidentCanSetRootCause('CORRECTION_DRAFTED')).toBe(false);
    expect(incidentCanResolve('REGRESSION_ADDED')).toBe(true);
    expect(incidentCanResolve('ROOT_CAUSE_FIXED')).toBe(false);
    expect(incidentCanCorrect('RESOLVED')).toBe(false);
    expect(incidentCanSetRootCause('RESOLVED')).toBe(false);
    expect(incidentCanResolve('RESOLVED')).toBe(false);
  });

  it('only enables regression at ROOT_CAUSE_FIXED and never repeats it', () => {
    expect(incidentCanAddRegression('OPEN')).toBe(false);
    expect(incidentCanAddRegression('CORRECTION_DRAFTED')).toBe(false);
    expect(incidentCanAddRegression('CORRECTED')).toBe(false);
    expect(incidentCanAddRegression('ROOT_CAUSE_FIXED')).toBe(true);
    expect(incidentCanAddRegression('REGRESSION_ADDED')).toBe(false);
    expect(incidentCanAddRegression('RESOLVED')).toBe(false);
  });
});
