import '@testing-library/jest-dom';

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.GEOAPIFY_API_KEY ||= 'test-geoapify-key';

if (typeof global.Request === 'undefined') {
  class MockHeaders {
    private headers: Record<string, string> = {};
    constructor(init?: Record<string, unknown>) {
      if (init) {
        Object.entries(init).forEach(([k, v]) => {
          this.headers[k.toLowerCase()] = String(v);
        });
      }
    }
    get(name: string) {
      return this.headers[name.toLowerCase()] || null;
    }
  }

  class MockRequest {
    public headers: MockHeaders;
    private bodyText: string;
    constructor(public url: string, public init?: { headers?: Record<string, unknown>; body?: string }) {
      this.headers = new MockHeaders(init?.headers);
      this.bodyText = init?.body || '';
    }
    async json() {
      return JSON.parse(this.bodyText);
    }
  }

  global.Request = MockRequest as unknown as typeof Request;
}

if (typeof global.Response === 'undefined') {
  class MockResponse {
    public status: number;
    public headers: { get: (name: string) => string | null };
    constructor(public body: unknown, public init?: { status?: number; headers?: Record<string, string> }) {
      this.status = init?.status || 200;
      this.headers = {
        get: (name: string) => this.init?.headers?.[name.toLowerCase()] || null
      };
    }
    async json() {
      return typeof this.body === 'string' ? JSON.parse(this.body) : this.body;
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockResponse(JSON.stringify(data), {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers }
      });
    }
  }
  global.Response = MockResponse as unknown as typeof Response;
}
