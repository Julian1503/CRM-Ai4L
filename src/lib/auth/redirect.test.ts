import { sanitizeNextPath } from './redirect'

describe('sanitizeNextPath', () => {
  it.each(['/contacts', '/contacts?state=NSW', '/settings#section', '/'])(
    'allows the relative path %s',
    (path) => {
      expect(sanitizeNextPath(path)).toBe(path)
    }
  )

  it.each([undefined, null, '', '   '])('falls back to / for %p', (value) => {
    expect(sanitizeNextPath(value)).toBe('/')
  })

  // Open redirect vectors. Post-login redirect is a classic phishing pivot: an
  // attacker sends /login?next=<their site>, the victim signs in for real and lands
  // on a convincing clone. Everything here must resolve to '/'.
  it.each([
    ['absolute http', 'http://evil.example.com'],
    ['absolute https', 'https://evil.example.com/path'],
    ['protocol-relative', '//evil.example.com'],
    ['protocol-relative with path', '//evil.example.com/contacts'],
    ['backslash protocol-relative', '\\\\evil.example.com'],
    ['mixed slash', '/\\evil.example.com'],
    ['backslash after slash', '/\\/evil.example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['scheme with leading space', ' https://evil.example.com'],
    ['no leading slash', 'contacts'],
    ['bare host', 'evil.example.com'],
    ['encoded protocol-relative', '/%2F%2Fevil.example.com'],
    ['tab-obfuscated scheme', 'ja\tvascript:alert(1)'],
    ['newline-obfuscated', '/contacts\n//evil.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeNextPath(value)).toBe('/')
  })

  it('rejects a path that is not a string', () => {
    expect(sanitizeNextPath(42 as unknown as string)).toBe('/')
    expect(sanitizeNextPath({} as unknown as string)).toBe('/')
  })

  it('never returns a value that a browser would treat as cross-origin', () => {
    const candidates = [
      '//evil.example.com',
      'https://evil.example.com',
      '/\\evil.example.com',
      '/contacts',
    ]

    for (const candidate of candidates) {
      const safe = sanitizeNextPath(candidate)
      const resolved = new URL(safe, 'https://crm.example.com')
      expect(resolved.origin).toBe('https://crm.example.com')
    }
  })
})
