import { TextDecoder, TextEncoder } from 'node:util';

import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Testing Library's findBy*/waitFor default is 1s, which is unrelated to Jest's own
// testTimeout and far tighter than the contended-worker reality this suite runs in:
// coverage instrumentation roughly doubles wall clock, and the heavier jsdom suites
// wait on several chained async round trips. Raised for the same reason testTimeout
// above is raised -- a query that would eventually pass should not fail because a
// worker was busy. Kept well under testTimeout so a genuine hang is still a hang.
configure({ asyncUtilTimeout: 5000 });

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
    public headers: Headers;
    constructor(public body: unknown, public init?: { status?: number; headers?: HeadersInit }) {
      this.status = init?.status || 200;
      // A real Headers, not a bare { get } object. NextResponse.json() calls the
      // static json() below and then re-wraps the result, passing that instance back
      // as `init` — so `init.headers` has to be something the second pass can read.
      // With a plain object the headers silently vanished on the re-wrap, every
      // `Cache-Control` assertion returned null, and a route that dropped the header
      // would still have passed its test. Headers also gives case-insensitive
      // lookup, which the previous implementation only half-applied.
      this.headers = new Headers(init?.headers ?? {});
    }
    async json() {
      return typeof this.body === 'string' ? JSON.parse(this.body) : this.body;
    }
    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }

      return new MockResponse(JSON.stringify(data), { ...init, headers });
    }
  }
  global.Response = MockResponse as unknown as typeof Response;
}

// jsdom omits TextEncoder/TextDecoder, which are globals in every real runtime this
// app targets (Node, the Edge runtime, browsers). The Anthropic SDK reaches for them
// at import time, so without this any suite that touches campaign generation fails
// with "TextEncoder is not defined" before a single test runs.
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
}
