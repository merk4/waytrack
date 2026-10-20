import { describe, expect, it } from 'vitest';
import { fakeFetch, jsonResponse, providerFixture, recordingBucket } from '../../../../test/helpers/http.ts';
import type { LngLat } from '../../../domain/geo/types.ts';
import { createOpenMeteoDem, retryAfterFromReason } from './openMeteoDem.ts';

const pts = (n: number): LngLat[] => Array.from({ length: n }, (_, i) => [23.75 + i * 1e-4, 37.96]);
const echo = (url: string) => jsonResponse({ elevation: new URL(url).searchParams.get('latitude')!.split(',').map(() => 130) });

describe('createOpenMeteoDem', () => {
  it('parses the recorded response', async () => {
    const f = providerFixture('openmeteo-elevation');
    const dem = createOpenMeteoDem({ locations: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse(f.body)) });
    expect(await dem.elevations([[23.7529167, 37.9622917], [23.75375, 37.963125]])).toEqual([130, 131]);
  });

  it('batches by 100 locations and paces by location count', async () => {
    const fetchImpl = fakeFetch(echo);
    const locations = recordingBucket();
    const out = await createOpenMeteoDem({ locations, fetchImpl }).elevations(pts(250));
    expect(out).toHaveLength(250);
    expect(fetchImpl.calls).toHaveLength(3);
    expect(locations.taken).toEqual([100, 100, 50]);
    const first = new URL(fetchImpl.calls[0]!.url);
    expect(first.searchParams.get('latitude')!.split(',')).toHaveLength(100);
  });

  it('maps the recorded 400 to invalid_request with the provider reason', async () => {
    const f = providerFixture('openmeteo-error');
    const dem = createOpenMeteoDem({ locations: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse(f.body, 400)) });
    await expect(dem.elevations(pts(1))).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('Latitude') });
  });

  it('maps 429 to rate_limited without futile retries, with the window from the reason', async () => {
    // Recorded live 2026-10-19.
    const hourly = fakeFetch(() => jsonResponse({ error: true, reason: 'Hourly API request limit exceeded. Please try again in the next hour.' }, 429));
    const dem = createOpenMeteoDem({ locations: recordingBucket(), fetchImpl: hourly, timeoutMs: 1000 });
    await expect(dem.elevations(pts(1))).rejects.toMatchObject({ code: 'rate_limited', retryAfterS: 3600 });
    expect(hourly.calls.length).toBe(1);
    expect(retryAfterFromReason('Minutely API request limit exceeded. Please try again in one minute.')).toBe(60);
    expect(retryAfterFromReason('Daily API request limit exceeded.')).toBe(86400);

    const short = createOpenMeteoDem({ locations: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse({ elevation: [1] })) });
    await expect(short.elevations(pts(2))).rejects.toMatchObject({ code: 'bad_response' });
  }, 30_000);
});
