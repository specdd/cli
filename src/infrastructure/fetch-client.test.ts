import { FetchClient } from './fetch-client.js';

describe('FetchClient', () => {
  it('returns status, ok, json, and bytes from fetch responses', async () => {
    const fetchClient = new FetchClient(async () => ({
      arrayBuffer: async () => new TextEncoder().encode('content').buffer,
      json: async () => ({
        ok: true,
      }),
      ok: true,
      status: 200,
    } as Response));

    const response = await fetchClient.get('https://example.test/resource');

    await expect(response.json()).resolves.toEqual({
      ok: true,
    });
    await expect(response.bytes()).resolves.toEqual(new TextEncoder().encode('content'));
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  });
});
