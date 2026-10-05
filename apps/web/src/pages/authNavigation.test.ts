import { describe, expect, it } from 'vitest';
import { getAuthDestination } from './authNavigation';

describe('getAuthDestination', () => {
  it.each([undefined, null, {}, { from: {} }, { from: { pathname: 'https://example.com' } }, { from: { pathname: '//example.com' } }, { from: { pathname: '/\\example.com' } }])('falls back for a missing or external destination: %j', (state) => {
    expect(getAuthDestination(state)).toBe('/dashboard');
  });

  it('preserves the path, query, and fragment of an internal destination', () => {
    expect(getAuthDestination({ from: { pathname: '/workspace/project', search: '?file=main.ts', hash: '#line-12' } })).toBe('/workspace/project?file=main.ts#line-12');
  });
});
