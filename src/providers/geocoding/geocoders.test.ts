import { describe, expect, it } from 'vitest';
import { fakeFetch, jsonResponse, providerFixture, recordingBucket } from '../../../test/helpers/http.ts';
import { createNominatimGeocoder } from './nominatim/nominatimGeocoder.ts';
import { createPhotonGeocoder } from './photon/photonGeocoder.ts';

const UA = 'Waymark/test';

describe('Nominatim', () => {
  it('maps the recorded search and sends policy-required headers/params', async () => {
    const f = providerFixture('nominatim-search');
    const fetchImpl = fakeFetch(() => jsonResponse(f.body));
    const limiter = recordingBucket();
    const g = createNominatimGeocoder({ userAgent: UA, limiter, fetchImpl });
    const res = await g.search({ text: 'Mesologgiou 49, Vironas', limit: 5, near: [23.75, 37.96], language: 'el' });
    expect(res[0]).toMatchObject({ name: 'Μεσολογγίου', position: [23.7553876, 37.9613474], kind: 'road' });
    expect(res[0]!.label).toContain('Βύρωνας');
    const call = fetchImpl.calls[0]!;
    expect((call.init.headers as Record<string, string>)['User-Agent']).toBe(UA);
    const url = new URL(call.url);
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('accept-language')).toBe('el');
    expect(url.searchParams.get('viewbox')).toBe('23.55,38.16,23.95,37.76');
    expect(url.searchParams.has('bounded')).toBe(false);
    expect(limiter.taken).toEqual([1]);
  });

  it('returns [] for the recorded empty response; maps errors', async () => {
    const empty = providerFixture('nominatim-empty');
    expect(await createNominatimGeocoder({ userAgent: UA, limiter: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse(empty.body)) }).search({ text: 'zz', limit: 5 })).toEqual([]);
    const bad = createNominatimGeocoder({ userAgent: UA, limiter: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse({ nope: 1 })) });
    await expect(bad.search({ text: 'x', limit: 1 })).rejects.toMatchObject({ code: 'bad_response' });
    const down = createNominatimGeocoder({ userAgent: UA, limiter: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse({}, 500)) });
    await expect(down.search({ text: 'x', limit: 1 })).rejects.toMatchObject({ code: 'unavailable', status: 500 });
  }, 20_000);
});

describe('Photon', () => {
  it('maps the recorded Greek search with location bias', async () => {
    const f = providerFixture('photon-search');
    const fetchImpl = fakeFetch(() => jsonResponse(f.body));
    const res = await createPhotonGeocoder({ userAgent: UA, limiter: recordingBucket(), fetchImpl }).search({
      text: 'Μεσολογγίου Βύρωνας',
      limit: 5,
      near: [23.75, 37.96],
    });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.name).toBe('Μεσολογγίου');
    expect(res[0]!.label).toContain('Βύρωνας');
    const url = new URL(fetchImpl.calls[0]!.url);
    expect([url.searchParams.get('lat'), url.searchParams.get('lon')]).toEqual(['37.96', '23.75']);
  });

  it('labels house-number results from street + number', async () => {
    const body = {
      type: 'FeatureCollection',
      features: [{ geometry: { type: 'Point', coordinates: [23.7, 37.9] }, properties: { street: 'Μεσολογγίου', housenumber: '49', city: 'Άλιμος', type: 'house' } }],
    };
    const res = await createPhotonGeocoder({ userAgent: UA, limiter: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse(body)) }).search({ text: 'x', limit: 1 });
    expect(res[0]).toMatchObject({ name: 'Μεσολογγίου 49', label: 'Μεσολογγίου 49, Άλιμος', kind: 'house' });
  });
});
