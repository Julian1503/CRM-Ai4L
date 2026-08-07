import { AUTH_FAILED_MESSAGE, validateLoginInput } from './credentials'

describe('validateLoginInput', () => {
  it('accepts a well-formed email and password', () => {
    expect(validateLoginInput('admin@example.com', 'correct horse battery')).toEqual({
      ok: true,
      email: 'admin@example.com',
      password: 'correct horse battery',
    })
  })

  it('normalises the email to lowercase and trims surrounding space', () => {
    const result = validateLoginInput('  Admin@Example.COM  ', 'pw')

    expect(result).toMatchObject({ ok: true, email: 'admin@example.com' })
  })

  it('does not trim the password, since spaces are legitimate characters', () => {
    const result = validateLoginInput('a@b.co', '  spaced  ')

    expect(result).toMatchObject({ ok: true, password: '  spaced  ' })
  })

  it.each([
    ['missing email', '', 'pw', 'email'],
    ['whitespace email', '   ', 'pw', 'email'],
    ['malformed email', 'not-an-email', 'pw', 'email'],
    ['email without domain', 'user@', 'pw', 'email'],
    ['missing password', 'a@b.co', '', 'password'],
  ])('rejects %s', (_label, email, password, field) => {
    const result = validateLoginInput(email, password)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fieldErrors[field as 'email' | 'password']).toEqual(expect.any(String))
    }
  })

  it('reports both fields when both are missing', () => {
    const result = validateLoginInput('', '')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fieldErrors.email).toEqual(expect.any(String))
      expect(result.fieldErrors.password).toEqual(expect.any(String))
    }
  })

  it('handles non-string input from a tampered form post', () => {
    const result = validateLoginInput(null as unknown as string, undefined as unknown as string)

    expect(result.ok).toBe(false)
  })

  it('uses one generic message for auth failure, to avoid user enumeration', () => {
    // A distinct "no such user" vs "wrong password" lets an attacker enumerate
    // valid accounts. Both paths must return this exact string.
    expect(AUTH_FAILED_MESSAGE).toBe('Invalid email or password.')
    expect(AUTH_FAILED_MESSAGE).not.toMatch(/not found|no account|unknown user|incorrect password/i)
  })
})
