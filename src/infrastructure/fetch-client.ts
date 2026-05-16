export type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  bytes(): Promise<Uint8Array>;
};

export type FetchImplementation = typeof fetch;

export class FetchClient {
  private readonly fetchImplementation: FetchImplementation;

  public constructor(fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis)) {
    this.fetchImplementation = fetchImplementation;
  }

  public async get(url: string): Promise<FetchResponse> {
    const response = await this.fetchImplementation(url);

    return {
      bytes: async (): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer()),
      json: async (): Promise<unknown> => response.json(),
      ok: response.ok,
      status: response.status,
    };
  }
}

export type FetchClientDependency = Pick<FetchClient, 'get'>;
